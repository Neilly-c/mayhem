import type { GameState, MoveCommand } from '../sim'
import { unitWorldPos, worldDistBetween } from '../sim'
import { computeVisibleEnemies } from '../env'
import type { UnitDecision } from './types'
import { decideAbilityCommand } from './abilityHelpers'
import { findNearestSafeNode, findNearestUnclaimedNode, pickBestDirection } from './movementHelpers'

/**
 * ユーザー要望: 陣営の目的(マップ占領率)に合わせた3性格の1つ、攻撃型。敵を減らすことを最優先
 * する — 敵を倒せばその分だけ相手は占領・奪還ができなくなるため、遠回りに見えて占領率争いでも
 * 有効な性格(倒した後の空き地は`expanderBot`と同じ手段で塗りに行く)。優先順位:
 *   1. リング退避: 現在地が安全圏外なら、HPや戦闘状況に関わらずリング中心へ最優先で戻る。
 *   2. 交戦: 射程内に敵がいればその場に留まり(静止時の指向性攻撃力ボーナスを活かす)攻撃する。
 *   3. 追撃: 視認中(射程外)の敵がいればその方向へ1歩(`pickBestDirection`)。
 *   4. 拡張: 敵が見えなければ自チーム未所有の最寄りノードへ(`expanderBot`と同じ手段)。
 * 低HPで退く判断は持たない(=逃げない性格) — 攻めっ気を優先する分、無傷では済まないことも
 * 多いという性格上のトレードオフ。
 */
export function decideCommands(state: GameState, unitIds: number[]): Map<number, UnitDecision> {
  const decisions = new Map<number, UnitDecision>()

  for (const unitId of unitIds) {
    const unit = state.units.find((u) => u.id === unitId)
    if (!unit || !unit.alive) continue

    const visibleEnemies = computeVisibleEnemies(state, unit)
    const inRangeEnemies = visibleEnemies.filter((e) => e.dist <= state.config.attackRange)
    const nearestEnemy = visibleEnemies[0] ?? null
    const attackTarget = inRangeEnemies[0]?.unit.id ?? null

    const outsideRing = worldDistBetween(unitWorldPos(state, unit), state.ring.centerWorld) > state.ring.activeRadius

    let command: MoveCommand

    if (outsideRing) {
      command = { type: 'moveTo', node: findNearestSafeNode(state, unit) ?? state.ring.nextCenter }
    } else if (inRangeEnemies.length > 0) {
      command = { type: 'moveTo', node: unit.pos.to }
    } else if (nearestEnemy) {
      const enemyWorldPos = unitWorldPos(state, nearestEnemy.unit)
      command = pickBestDirection(state, unit, (candidate) => -worldDistBetween(candidate, enemyWorldPos))
    } else {
      const target = findNearestUnclaimedNode(state, unit)
      command = target !== null ? { type: 'moveTo', node: target } : { type: 'idle' }
    }

    decisions.set(unitId, { command, attackTarget, abilityCommand: decideAbilityCommand(state, unit, visibleEnemies) })
  }

  return decisions
}
