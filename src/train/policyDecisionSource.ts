import * as tf from '@tensorflow/tfjs'
import type { GameState } from '../sim'
import { buildActionMask, buildNodeIndex, buildObservation, computeVisibleEnemies, decodeAction } from '../env'
import type { DecisionSource, UnitDecision } from '../agents'
import type { ActorCriticModel } from './network'
import { argmaxMaskedCategorical, sampleMaskedCategorical } from './actionSampling'

export interface PolicyDecisionSourceOptions {
  /** true(既定): マスク済みlogitsのargmaxで行動を選ぶ(評価・対戦向け、再現性重視)。
   * false: 学習時と同じ確率的サンプリング。 */
  deterministic?: boolean
  /** 確率的サンプリング時(`deterministic: false`)に`tf.multinomial`へ渡すseed。 */
  seed?: number
}

/**
 * 学習済みポリシーを、他のbot(`scriptedBot`/`decisionTreeBot`/`survivalBot`)と同じ`DecisionSource`
 * 形状で使えるようにする橋渡し。envが内部で使っているのと同じ純粋関数
 * (`buildObservation`/`buildActionMask`/`decodeAction`)をそのまま再利用するため、学習時と
 * ライブ実行時とで観測・行動デコードの実装が二重化しない。evaluate.tsでの対戦評価に使うほか、
 * 将来的に`src/agents`/`ControlPanel.tsx`へ組み込んでブラウザ上でライブ対戦させる際の
 * 継ぎ目にもなる(その組み込み自体は本パイプラインのスコープ外)。
 */
export function createPolicyDecisionSource(
  model: ActorCriticModel,
  options: PolicyDecisionSourceOptions = {},
): DecisionSource {
  const deterministic = options.deterministic ?? true

  return (state: GameState, unitIds: number[]) => {
    const decisions = new Map<number, UnitDecision>()
    if (unitIds.length === 0) return decisions

    const nodeIndex = buildNodeIndex(state)
    const entries: { unitId: number; posTo: number; visibleEnemyIds: number[] }[] = []
    const obsRows: number[][] = []
    const moveMaskRows: number[][] = []
    const attackMaskRows: number[][] = []

    for (const unitId of unitIds) {
      const unit = state.units.find((u) => u.id === unitId)
      if (!unit || !unit.alive) continue
      const visibleEnemies = computeVisibleEnemies(state, unit)
      const observation = buildObservation(state, unit, visibleEnemies, nodeIndex)
      const mask = buildActionMask(state, unit, visibleEnemies)
      entries.push({ unitId, posTo: unit.pos.to, visibleEnemyIds: observation.visibleEnemyIds })
      obsRows.push(observation.vector)
      moveMaskRows.push(mask.move.map((b) => (b ? 1 : 0)))
      attackMaskRows.push(mask.attack.map((b) => (b ? 1 : 0)))
    }
    if (entries.length === 0) return decisions

    const { moveActions, attackActions } = tf.tidy(() => {
      const obsT = tf.tensor2d(obsRows)
      const moveMaskT = tf.tensor2d(moveMaskRows)
      const attackMaskT = tf.tensor2d(attackMaskRows)
      const { moveLogits, attackLogits } = model.forward(obsT)

      if (deterministic) {
        const moveA = argmaxMaskedCategorical(moveLogits, moveMaskT)
        const attackA = argmaxMaskedCategorical(attackLogits, attackMaskT)
        return { moveActions: Array.from(moveA.dataSync()), attackActions: Array.from(attackA.dataSync()) }
      }
      const moveSample = sampleMaskedCategorical(moveLogits, moveMaskT, options.seed)
      const attackSample = sampleMaskedCategorical(attackLogits, attackMaskT, options.seed)
      return {
        moveActions: Array.from(moveSample.actions.dataSync()),
        attackActions: Array.from(attackSample.actions.dataSync()),
      }
    })

    entries.forEach((entry, i) => {
      const { command, attackTarget } = decodeAction(
        { move: moveActions[i], attack: attackActions[i] },
        entry.posTo,
        entry.visibleEnemyIds,
      )
      decisions.set(entry.unitId, { command, attackTarget })
    })

    return decisions
  }
}
