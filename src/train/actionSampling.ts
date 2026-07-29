import * as tf from '@tensorflow/tfjs'

export interface HeadSample {
  /** [B], int32. サンプルされた行動インデックス。 */
  actions: tf.Tensor1D
  /** [B]。サンプルされた行動の、マスク適用後の分布でのlog確率。 */
  logProbs: tf.Tensor1D
  /** [B]。マスク適用後の分布のエントロピー。 */
  entropy: tf.Tensor1D
}

/**
 * `(mask-1)*1e9`の加算バイアス方式でマスクする。mask=1(合法)ならバイアス0、mask=0(非合法)なら
 * バイアス-1e9。float32では`exp(-1e9ish)`は厳密に0.0まで下がる(生の`-Infinity`バイアスだと
 * `0 * -Infinity = NaN`になるが、有限の-1e9なら`0.0 * 有限値 = 0.0`で済む)ため、
 * 非合法な行動の確率・log確率・エントロピーへの寄与がNaNを出さずに正しくゼロになる。
 */
function maskedLogSoftmax(logits: tf.Tensor2D, mask: tf.Tensor2D): tf.Tensor2D {
  const bias = tf.mul(tf.sub(mask, 1), 1e9)
  const masked = tf.add(logits, bias) as tf.Tensor2D
  return tf.logSoftmax(masked)
}

function entropyFromLogProbs(logProbs: tf.Tensor2D): tf.Tensor1D {
  const probs = tf.exp(logProbs)
  return tf.neg(tf.sum(tf.mul(probs, logProbs), -1)) as tf.Tensor1D
}

function gatherLogProb(logProbs: tf.Tensor2D, actions: tf.Tensor1D): tf.Tensor1D {
  const numActions = logProbs.shape[1]
  const oneHot = tf.oneHot(actions, numActions) as tf.Tensor2D
  return tf.sum(tf.mul(logProbs, oneHot), -1) as tf.Tensor1D
}

/** ロールアウト収集時: 新しい行動をサンプルする。move/attackの各ヘッドに独立に使う。 */
export function sampleMaskedCategorical(logits: tf.Tensor2D, mask: tf.Tensor2D, seed?: number): HeadSample {
  return tf.tidy(() => {
    const bias = tf.mul(tf.sub(mask, 1), 1e9)
    const masked = tf.add(logits, bias) as tf.Tensor2D
    const logProbsAll = tf.logSoftmax(masked)
    const sampled = tf.multinomial(masked, 1, seed) as tf.Tensor2D // [B,1]
    const actions = sampled.reshape([logits.shape[0]]) as tf.Tensor1D
    const logProbs = gatherLogProb(logProbsAll, actions)
    const entropy = entropyFromLogProbs(logProbsAll)
    return { actions, logProbs, entropy }
  })
}

/** 決定的な行動選択(評価・対戦向け): マスク適用後のlogitsが最大の行動を選ぶ。サンプリングしない。 */
export function argmaxMaskedCategorical(logits: tf.Tensor2D, mask: tf.Tensor2D): tf.Tensor1D {
  return tf.tidy(() => {
    const bias = tf.mul(tf.sub(mask, 1), 1e9)
    const masked = tf.add(logits, bias) as tf.Tensor2D
    return tf.argMax(masked, -1) as tf.Tensor1D
  })
}

/**
 * PPO更新時: ロールアウトで既に選ばれた行動を、現在(更新中)のポリシーのlogitsで再評価する
 * (サンプルし直さない)。PPO比`exp(newLogProb - oldLogProb)`とエントロピーボーナスに使う。
 */
export function evaluateMaskedCategorical(
  logits: tf.Tensor2D,
  mask: tf.Tensor2D,
  actions: tf.Tensor1D,
): { logProbs: tf.Tensor1D; entropy: tf.Tensor1D } {
  return tf.tidy(() => {
    const logProbsAll = maskedLogSoftmax(logits, mask)
    const logProbs = gatherLogProb(logProbsAll, actions)
    const entropy = entropyFromLogProbs(logProbsAll)
    return { logProbs, entropy }
  })
}
