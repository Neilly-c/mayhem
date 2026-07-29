import type { GameState, MoveCommand } from '../sim'
import { unitWorldPos, worldDistBetween } from '../sim'
import { computeVisibleEnemies } from '../env'
import { pickBestDirection } from './movementHelpers'

export interface UnitDecision {
  command: MoveCommand
  attackTarget: number | null
}

/**
 * 最小のスクリプトbot(Phase 5の`src/agents/`から先出し): 移動は基本`idle`で、simの探索
 * フォールバック(§5)に任せる。唯一の例外はリング外(ユーザー要望: 「リング外を優先度高めに
 * 避ける」)で、その場合はHPや戦闘状況に関わらずリング中心へ最優先で戻る。攻撃は視認中×射程内の
 * 最寄り敵に自動で狙いを定める(リング退避中も反撃は続ける)。追跡・退避などそれ以外の意思決定は
 * 持たない(それはRL方策や判断木botが担う領域)。
 */
export function decideCommands(state: GameState, unitIds: number[]): Map<number, UnitDecision> {
  const decisions = new Map<number, UnitDecision>()

  for (const unitId of unitIds) {
    const unit = state.units.find((u) => u.id === unitId)
    if (!unit || !unit.alive) continue

    const visibleEnemies = computeVisibleEnemies(state, unit)
    const nearestInRange = visibleEnemies.find((e) => e.dist <= state.config.attackRange)

    const outsideRing = worldDistBetween(unitWorldPos(state, unit), state.ring.centerWorld) > state.ring.activeRadius
    const command: MoveCommand = outsideRing
      ? pickBestDirection(state, unit, (candidate) => -worldDistBetween(candidate, state.ring.centerWorld))
      : { type: 'idle' }

    decisions.set(unitId, {
      command,
      attackTarget: nearestInRange ? nearestInRange.unit.id : null,
    })
  }

  return decisions
}
