import type { GameState, UnitState } from '../sim'
import { unitWorldPos, withinVisionStar, worldDistBetween } from '../sim'

export interface VisibleEnemy {
  unit: UnitState
  dist: number
}

/**
 * §11.2/§11.3 観測と行動マスクの両方が参照する「視認中の敵」リスト。距離昇順・
 * `maxVisibleEnemies`件までに切り詰め済み。両モジュールがこの同じ並びを使うことで、
 * 観測のスロットiと攻撃ヘッドのスロットiが常に同じ相手を指す。
 *
 * ユーザー要望: 視認可否そのものは「近傍`visionCoreRadius`ホップの正六角形+6方向直線
 * `visionSpikeRange`ホップの棘」というヘックスのホップ距離ベースの二重形状(`withinVisionStar`)
 * で判定する(直線状に飛ぶペイントボール/レーザーの狙い先を遠くまで見通せるようにするため)。
 * `dist`(ソート順・`attackRange`比較に使う)自体は従来通り連続ワールド距離のまま。
 */
export function computeVisibleEnemies(state: GameState, self: UnitState): VisibleEnemy[] {
  const selfPos = unitWorldPos(state, self)
  const selfNode = state.nodes[self.pos.to]
  const enemies: VisibleEnemy[] = []
  for (const other of state.units) {
    if (!other.alive || other.teamId === self.teamId) continue
    const otherNode = state.nodes[other.pos.to]
    if (!withinVisionStar(selfNode, otherNode, state.config.visionCoreRadius, state.config.visionSpikeRange)) continue
    const dist = worldDistBetween(selfPos, unitWorldPos(state, other))
    enemies.push({ unit: other, dist })
  }
  enemies.sort((a, b) => a.dist - b.dist)
  return enemies.slice(0, state.config.maxVisibleEnemies)
}
