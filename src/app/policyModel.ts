import * as tf from '@tensorflow/tfjs'
import type { AbilityKind, GameState } from '../sim'
import { buildActionMask, buildNodeIndex, buildObservation, computeVisibleEnemies, decodeAction } from '../env'
import type { DecisionSource, UnitDecision } from '../agents'

export interface CheckpointInfo {
  dir: string
  iteration: number
  score: number | null
  createdAt: string
}

/** `vite.config.ts`の開発サーバー専用ルートが返す一覧。npm run dev実行中しか存在しない。 */
export async function fetchCheckpointManifest(): Promise<CheckpointInfo[]> {
  const res = await fetch('/checkpoints/manifest.json', { cache: 'no-store' })
  if (!res.ok) throw new Error(`checkpoint manifest fetch failed: ${res.status}`)
  return (await res.json()) as CheckpointInfo[]
}

/** 反復回数が最大のチェックポイント。 */
export function pickLatestCheckpoint(checkpoints: CheckpointInfo[]): CheckpointInfo | null {
  if (checkpoints.length === 0) return null
  return checkpoints.reduce((a, b) => (b.iteration > a.iteration ? b : a))
}

/** `score`(全対戦相手の平均勝率、`src/train/checkpointPruning.ts`の`meanWinRate`)が最大の
 * チェックポイント。`score`が無い(未評価)ものは対象外 — 1件もスコア付きが無ければ`null`。 */
export function pickBestCheckpoint(checkpoints: CheckpointInfo[]): CheckpointInfo | null {
  const scored = checkpoints.filter((c): c is CheckpointInfo & { score: number } => c.score !== null)
  if (scored.length === 0) return null
  return scored.reduce((a, b) => (b.score > a.score ? b : a))
}

/** チェックポイントの`model.json`/`weights.bin`をHTTP経由でブラウザに読み込む。TF.jsの
 * ブラウザ標準IOHandler(fetchベース)を使うだけで、Node専用コード(`src/train/network.ts`の
 * fsベースIOHandler)には一切依存しない。 */
export async function loadPolicyModel(checkpointDir: string): Promise<tf.LayersModel> {
  return (await tf.loadLayersModel(`/checkpoints/${checkpointDir}/model.json`)) as tf.LayersModel
}

/**
 * `src/train/actionSampling.ts`の`argmaxMaskedCategorical`と同一実装の小さな複製。`src/train/`は
 * Node専用ビルド(fsベースのモデルIOなど)なので`tsconfig.app.json`から除外されておりブラウザ
 * バンドルへ持ち込めない。この関数自体は純粋なTF.js計算でNode依存が無いが、ファイル単位で
 * ビルド境界を分けている以上ここだけ複製する方が安全(`training-py`の`network.py`が
 * `network.ts`を「構造的1:1移植」しているのと同じ考え方)。
 */
function argmaxMaskedCategorical(logits: tf.Tensor2D, mask: tf.Tensor2D): tf.Tensor1D {
  return tf.tidy(() => {
    const bias = tf.mul(tf.sub(mask, 1), 1e9)
    const masked = tf.add(logits, bias) as tf.Tensor2D
    return tf.argMax(masked, -1) as tf.Tensor1D
  })
}

/**
 * 学習済みモデルを、他のbot(`expanderBot`/`guardianBot`/`raiderBot`)と同じ`DecisionSource`
 * 形状で使えるようにする橋渡し(ブラウザ版)。`src/train/policyDecisionSource.ts`のNode版と
 * ロジックは同一だが、`ActorCriticModel`ではなくロード直後の生の`tf.LayersModel`を直接叩く。
 * 常に決定的(argmax)行動選択 — ライブ観戦での再現性を優先し、学習時のような確率的サンプリング
 * は行わない。
 */
export function createBrowserPolicyDecisionSource(model: tf.LayersModel): DecisionSource {
  return (state: GameState, unitIds: number[]) => {
    const decisions = new Map<number, UnitDecision>()
    if (unitIds.length === 0) return decisions

    const nodeIndex = buildNodeIndex(state)
    const entries: { unitId: number; posTo: number; visibleEnemyIds: number[]; ability: AbilityKind }[] = []
    const obsRows: number[][] = []
    const moveMaskRows: number[][] = []
    const attackMaskRows: number[][] = []
    const abilityMaskRows: number[][] = []

    for (const unitId of unitIds) {
      const unit = state.units.find((u) => u.id === unitId)
      if (!unit || !unit.alive) continue
      const visibleEnemies = computeVisibleEnemies(state, unit)
      const observation = buildObservation(state, unit, visibleEnemies, nodeIndex)
      const mask = buildActionMask(state, unit, visibleEnemies)
      entries.push({ unitId, posTo: unit.pos.to, visibleEnemyIds: observation.visibleEnemyIds, ability: unit.ability })
      obsRows.push(observation.vector)
      moveMaskRows.push(mask.move.map((b) => (b ? 1 : 0)))
      attackMaskRows.push(mask.attack.map((b) => (b ? 1 : 0)))
      abilityMaskRows.push(mask.ability.map((b) => (b ? 1 : 0)))
    }
    if (entries.length === 0) return decisions

    const { moveActions, attackActions, abilityActions } = tf.tidy(() => {
      const obsT = tf.tensor2d(obsRows)
      const moveMaskT = tf.tensor2d(moveMaskRows)
      const attackMaskT = tf.tensor2d(attackMaskRows)
      const abilityMaskT = tf.tensor2d(abilityMaskRows)
      const [moveLogits, attackLogits, abilityLogits] = model.apply(obsT) as tf.Tensor2D[]
      const moveA = argmaxMaskedCategorical(moveLogits, moveMaskT)
      const attackA = argmaxMaskedCategorical(attackLogits, attackMaskT)
      const abilityA = argmaxMaskedCategorical(abilityLogits, abilityMaskT)
      return {
        moveActions: Array.from(moveA.dataSync()),
        attackActions: Array.from(attackA.dataSync()),
        abilityActions: Array.from(abilityA.dataSync()),
      }
    })

    entries.forEach((entry, i) => {
      const { command, attackTarget, abilityCommand } = decodeAction(
        { move: moveActions[i], attack: attackActions[i], ability: abilityActions[i] },
        entry.posTo,
        entry.visibleEnemyIds,
        entry.ability,
        state.config,
      )
      decisions.set(entry.unitId, { command, attackTarget, abilityCommand })
    })

    return decisions
  }
}
