import type { GameState, UnitState } from '../sim'
import { unitWorldPos, worldDistBetween } from '../sim'

export interface VisibleEnemy {
  unit: UnitState
  dist: number
}

/**
 * §11.2/§11.3 観測と行動マスクの両方が参照する「視認中の敵」リスト。距離昇順・
 * `maxVisibleEnemies`件までに切り詰め済み。両モジュールがこの同じ並びを使うことで、
 * 観測のスロットiと攻撃ヘッドのスロットiが常に同じ相手を指す。
 */
export function computeVisibleEnemies(state: GameState, self: UnitState): VisibleEnemy[] {
  const selfPos = unitWorldPos(state, self)
  const enemies: VisibleEnemy[] = []
  for (const other of state.units) {
    if (!other.alive || other.teamId === self.teamId) continue
    const dist = worldDistBetween(selfPos, unitWorldPos(state, other))
    if (dist <= state.config.visionRange) enemies.push({ unit: other, dist })
  }
  enemies.sort((a, b) => a.dist - b.dist)
  return enemies.slice(0, state.config.maxVisibleEnemies)
}
