import * as tf from '@tensorflow/tfjs'
import type { RngFn } from '../sim'
import { randInt } from '../sim'
import type { ActorCriticModel } from './network'
import { evaluateMaskedCategorical } from './actionSampling'
import type { PPOConfig, RolloutBatch } from './types'

export interface PpoUpdateStats {
  policyLoss: number
  valueLoss: number
  entropy: number
  /** "k2"近似KL(0.5 * mean((newLogProb-oldLogProb)^2))。学習が暴走していないかの目安。 */
  approxKl: number
  /** レシオがクリップ範囲外だったサンプルの割合。 */
  clipFraction: number
}

function shuffledIndices(n: number, rng: RngFn): number[] {
  const indices = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = randInt(rng, i + 1)
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices
}

/**
 * PPOのクリップ付きサロゲート目的関数による1回の更新(複数epoch・ミニバッチSGD)。
 *
 * `tf.variableGrads(loss)`はvarList省略で呼ぶ — 省略時はプロセス内の全trainable変数が対象になる
 * ため、呼び出し時点でこの`model`以外に学習対象のtrainable変数が存在しないこと(network.tsの
 * ドキュメント参照)。損失計算は`tf.tidy`でラップしてよい(検証済み: `variableGrads`のコールバック内で
 * `tf.tidy`をネストしても、逆伝播に必要な中間tensorはエンジンが正しく保護するため勾配は壊れない) —
 * これにより中間tensor(1ミニバッチあたり十数個)を1つずつ手動disposeせずに済む。
 * ミニバッチのgather結果とgradだけは`tf.tidy`の外で生成される値なので、明示的にdisposeする。
 */
export function runPpoUpdate(
  model: ActorCriticModel,
  optimizer: tf.Optimizer,
  batch: RolloutBatch,
  config: PPOConfig,
  rng: RngFn,
): PpoUpdateStats {
  const steps = batch.steps
  const n = steps.length
  if (n === 0) {
    return { policyLoss: 0, valueLoss: 0, entropy: 0, approxKl: 0, clipFraction: 0 }
  }

  const obsT = tf.tensor2d(steps.map((s) => s.obs))
  const moveMaskT = tf.tensor2d(steps.map((s) => s.moveMask.map((b) => (b ? 1 : 0))))
  const attackMaskT = tf.tensor2d(steps.map((s) => s.attackMask.map((b) => (b ? 1 : 0))))
  const moveActionsT = tf.tensor1d(
    steps.map((s) => s.moveAction),
    'int32',
  )
  const attackActionsT = tf.tensor1d(
    steps.map((s) => s.attackAction),
    'int32',
  )
  const oldLogProbT = tf.tensor1d(steps.map((s) => s.oldLogProb))
  const oldValueT = tf.tensor1d(steps.map((s) => s.value))
  const returnsT = tf.tensor1d(steps.map((s) => s.return))

  // バッチ全体で1回だけ正規化する(epochループの外側)。
  const rawAdvantages = steps.map((s) => s.advantage)
  const advMean = rawAdvantages.reduce((a, b) => a + b, 0) / n
  const advVariance = rawAdvantages.reduce((a, b) => a + (b - advMean) ** 2, 0) / n
  const advStd = Math.sqrt(advVariance)
  const advantagesT = tf.tensor1d(rawAdvantages.map((a) => (a - advMean) / (advStd + 1e-8)))

  const useClippedValueLoss = config.clipValueLoss ?? true
  const accum = { policyLoss: 0, valueLoss: 0, entropy: 0, approxKl: 0, clipFraction: 0, weight: 0 }

  try {
    for (let epoch = 0; epoch < config.epochs; epoch++) {
      const order = shuffledIndices(n, rng)
      for (let start = 0; start < n; start += config.minibatchSize) {
        const idx = order.slice(start, start + config.minibatchSize)
        const idxT = tf.tensor1d(idx, 'int32')

        let batchStats: PpoUpdateStats | undefined

        const { value: lossValue, grads } = tf.variableGrads(() =>
          tf.tidy(() => {
            const obsSlice = tf.gather(obsT, idxT) as tf.Tensor2D
            const moveMaskSlice = tf.gather(moveMaskT, idxT) as tf.Tensor2D
            const attackMaskSlice = tf.gather(attackMaskT, idxT) as tf.Tensor2D
            const moveActionsSlice = tf.gather(moveActionsT, idxT) as tf.Tensor1D
            const attackActionsSlice = tf.gather(attackActionsT, idxT) as tf.Tensor1D
            const oldLogProbSlice = tf.gather(oldLogProbT, idxT) as tf.Tensor1D
            const oldValueSlice = tf.gather(oldValueT, idxT) as tf.Tensor1D
            const returnsSlice = tf.gather(returnsT, idxT) as tf.Tensor1D
            const advantagesSlice = tf.gather(advantagesT, idxT) as tf.Tensor1D

            const { moveLogits, attackLogits, value } = model.forward(obsSlice)
            const moveEval = evaluateMaskedCategorical(moveLogits, moveMaskSlice, moveActionsSlice)
            const attackEval = evaluateMaskedCategorical(attackLogits, attackMaskSlice, attackActionsSlice)
            const newLogProb = tf.add(moveEval.logProbs, attackEval.logProbs) as tf.Tensor1D
            const entropyPerSample = tf.add(moveEval.entropy, attackEval.entropy) as tf.Tensor1D

            const ratio = tf.exp(tf.sub(newLogProb, oldLogProbSlice))
            const surr1 = tf.mul(ratio, advantagesSlice)
            const clippedRatio = tf.clipByValue(ratio, 1 - config.clipRatio, 1 + config.clipRatio)
            const surr2 = tf.mul(clippedRatio, advantagesSlice)
            const policyLoss = tf.neg(tf.mean(tf.minimum(surr1, surr2))) as tf.Scalar

            const valuePred = value.reshape([value.shape[0]]) as tf.Tensor1D
            let valueLossTensor: tf.Scalar
            if (useClippedValueLoss) {
              const delta = tf.clipByValue(tf.sub(valuePred, oldValueSlice), -config.clipRatio, config.clipRatio)
              const valueClipped = tf.add(oldValueSlice, delta)
              const lossUnclipped = tf.square(tf.sub(valuePred, returnsSlice))
              const lossClipped = tf.square(tf.sub(valueClipped, returnsSlice))
              valueLossTensor = tf.mean(tf.maximum(lossUnclipped, lossClipped)) as tf.Scalar
            } else {
              valueLossTensor = tf.mean(tf.square(tf.sub(valuePred, returnsSlice))) as tf.Scalar
            }

            const entropyMean = tf.mean(entropyPerSample) as tf.Scalar
            const total = tf.add(
              tf.add(policyLoss, tf.mul(valueLossTensor, config.valueLossCoef)),
              tf.neg(tf.mul(entropyMean, config.entropyCoef)),
            ) as tf.Scalar

            const approxKl = tf.mul(tf.mean(tf.square(tf.sub(newLogProb, oldLogProbSlice))), 0.5) as tf.Scalar
            const clipFrac = tf.mean(
              tf.cast(tf.greater(tf.abs(tf.sub(ratio, 1)), config.clipRatio), 'float32'),
            ) as tf.Scalar

            batchStats = {
              policyLoss: policyLoss.dataSync()[0],
              valueLoss: valueLossTensor.dataSync()[0],
              entropy: entropyMean.dataSync()[0],
              approxKl: approxKl.dataSync()[0],
              clipFraction: clipFrac.dataSync()[0],
            }

            return total
          }),
        )

        optimizer.applyGradients(grads)

        const weight = idx.length
        if (batchStats) {
          accum.policyLoss += batchStats.policyLoss * weight
          accum.valueLoss += batchStats.valueLoss * weight
          accum.entropy += batchStats.entropy * weight
          accum.approxKl += batchStats.approxKl * weight
          accum.clipFraction += batchStats.clipFraction * weight
          accum.weight += weight
        }

        lossValue.dispose()
        for (const key in grads) grads[key].dispose()
        idxT.dispose()
      }
    }
  } finally {
    tf.dispose([obsT, moveMaskT, attackMaskT, moveActionsT, attackActionsT, oldLogProbT, oldValueT, returnsT, advantagesT])
  }

  const w = Math.max(1, accum.weight)
  return {
    policyLoss: accum.policyLoss / w,
    valueLoss: accum.valueLoss / w,
    entropy: accum.entropy / w,
    approxKl: accum.approxKl / w,
    clipFraction: accum.clipFraction / w,
  }
}
