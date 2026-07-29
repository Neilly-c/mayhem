import type { GameState } from './types'

/**
 * ユーザー要望: 自チーム所有ノードで静止しているユニットは、`territoryRegenRate`(既定0.05
 * HP/tick、極めてゆっくり)でHPが回復する。移動中・敵/中立ノード上・満タン時は対象外。
 */
export function applyRegen(state: GameState): { unitId: number; amount: number }[] {
  const rate = state.config.territoryRegenRate
  if (rate <= 0) return []

  const events: { unitId: number; amount: number }[] = []
  for (const unit of state.units) {
    if (!unit.alive) continue
    if (unit.pos.from !== unit.pos.to) continue
    if (state.nodes[unit.pos.to].owner !== unit.teamId) continue
    if (unit.hp >= state.config.unitHP) continue

    const amount = Math.min(rate, state.config.unitHP - unit.hp)
    unit.hp += amount
    events.push({ unitId: unit.id, amount })
  }
  return events
}
