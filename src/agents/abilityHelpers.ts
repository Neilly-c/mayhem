import type { AbilityCommand, GameState, NodeState, UnitState, Vec2 } from '../sim'
import { DIRECTIONS, unitWorldPos, world } from '../sim'
import type { VisibleEnemy } from '../env'
import { findNearestUnclaimedNode } from './movementHelpers'

/** 自ノードから見て、`targetWorldPos`に最も近い角度の6方向のうちの1つを返す(§`raiderBot`等が
 * ペイントボール/レーザーの発射方向を選ぶのに使う近似 — 厳密な一直線でなくても、視野の棘
 * (`withinVisionStar`)の判定と違い着弾判定自体は方向+距離だけで決まるので、近似角でも撃てる)。 */
function directionToward(selfNode: NodeState, targetWorldPos: Vec2): 0 | 1 | 2 | 3 | 4 | 5 {
  const selfWorld = world(selfNode)
  const vx = targetWorldPos.x - selfWorld.x
  const vy = targetWorldPos.y - selfWorld.y

  let bestDir: 0 | 1 | 2 | 3 | 4 | 5 = 0
  let bestDot = -Infinity
  for (let dir = 0; dir < 6; dir++) {
    const dirVec = world(DIRECTIONS[dir])
    const dot = vx * dirVec.x + vy * dirVec.y
    if (dot > bestDot) {
      bestDot = dot
      bestDir = dir as 0 | 1 | 2 | 3 | 4 | 5
    }
  }
  return bestDir
}

/**
 * ユーザー要望: 3種のbot(`expanderBot`/`guardianBot`/`raiderBot`)が共有する、装備アビリティ
 * ごとの簡易発動判断。攻撃系(paintball/laser)はノード上で静止中のみ、視認中の敵がいれば
 * その方向、いなければ拡張目標(未所有ノード)の方向へ狙う。バフ系(damageShield/chainDamage)は
 * 敵が見えている間だけ、speedBoostは(常に有用なので)クールダウン明けなら常に発動を試みる。
 */
export function decideAbilityCommand(
  state: GameState,
  unit: UnitState,
  visibleEnemies: VisibleEnemy[],
): AbilityCommand {
  if (unit.abilityCooldownRemaining > 0) return { type: 'none' }

  switch (unit.ability) {
    case 'paintball':
    case 'laser': {
      if (unit.pos.from !== unit.pos.to) return { type: 'none' }
      const selfNode = state.nodes[unit.pos.to]
      const maxRange = unit.ability === 'paintball' ? state.config.paintballMaxRange : state.config.laserRange

      if (visibleEnemies.length > 0) {
        const nearest = visibleEnemies[0]
        const dir = directionToward(selfNode, unitWorldPos(state, nearest.unit))
        const range = Math.max(1, Math.min(maxRange, Math.round(nearest.dist)))
        return { type: 'directional', dir, range }
      }

      const unclaimed = findNearestUnclaimedNode(state, unit)
      if (unclaimed === null) return { type: 'none' }
      const dir = directionToward(selfNode, world(state.nodes[unclaimed]))
      return { type: 'directional', dir, range: maxRange }
    }
    case 'speedBoost':
      return { type: 'selfBuff' }
    case 'damageShield':
    case 'chainDamage':
      return visibleEnemies.length > 0 ? { type: 'selfBuff' } : { type: 'none' }
  }
}
