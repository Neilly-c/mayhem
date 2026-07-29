import type { GameState, MoveCommand } from '../sim'
import { unitWorldPos, worldDistBetween } from '../sim'
import { computeVisibleEnemies } from '../env'
import type { UnitDecision } from './types'
import { findNearestSafeNode, findNearestUnclaimedNode } from './movementHelpers'

/**
 * ユーザー要望: 陣営の目的(マップ占領率)に合わせた3性格の1つ、拡張型。戦闘は極力避け、
 * ひたすら未所有ノードを塗り続けることだけを考える(§territory.tsの通り、中立ノードは
 * 通過するだけで即座に奪えるため、目的地への移動そのものが道中を塗ることになる)。
 * 優先順位:
 *   1. リング退避: 現在地が安全圏外なら、HPや戦闘状況に関わらずリング中心へ最優先で戻る。
 *   2. 拡張: 自チーム未所有の最寄りノード(`findNearestUnclaimedNode`、中立優先)へ向かう。
 *      見つからなければ(=到達可能な全ノードを既に自チームが所有)idle。
 * 攻撃は独立ヘッドとして常に「射程内の最寄り敵」に反撃する(移動判断とは無関係。追撃はしない、
 * 自ら戦闘に寄っていかない)。低HPで逃げる判断も持たないため、敵地へ突っ込んで落命することもある
 * — その分「生きている間はひたすら塗り続ける」ことに全振りした性格。
 */
export function decideCommands(state: GameState, unitIds: number[]): Map<number, UnitDecision> {
  const decisions = new Map<number, UnitDecision>()

  for (const unitId of unitIds) {
    const unit = state.units.find((u) => u.id === unitId)
    if (!unit || !unit.alive) continue

    const visibleEnemies = computeVisibleEnemies(state, unit)
    const nearestInRange = visibleEnemies.find((e) => e.dist <= state.config.attackRange)

    const outsideRing = worldDistBetween(unitWorldPos(state, unit), state.ring.centerWorld) > state.ring.activeRadius

    let command: MoveCommand
    if (outsideRing) {
      command = { type: 'moveTo', node: findNearestSafeNode(state, unit) ?? state.ring.nextCenter }
    } else {
      const target = findNearestUnclaimedNode(state, unit)
      command = target !== null ? { type: 'moveTo', node: target } : { type: 'idle' }
    }

    decisions.set(unitId, {
      command,
      attackTarget: nearestInRange ? nearestInRange.unit.id : null,
    })
  }

  return decisions
}
