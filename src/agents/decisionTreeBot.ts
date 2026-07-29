import type { GameState, MoveCommand, UnitState } from '../sim'
import { unitWorldPos, worldDistBetween } from '../sim'
import { computeVisibleEnemies } from '../env'
import type { UnitDecision } from './scriptedBot'
import { pickBestDirection } from './movementHelpers'

export interface DecisionTreeConfig {
  /** Below this HP fraction, a unit with a visible enemy flees instead of fighting. */
  fleeHpFraction: number
}

export function defaultDecisionTreeConfig(): DecisionTreeConfig {
  return { fleeHpFraction: 0.3 }
}

export function createDecisionTreeConfig(overrides?: Partial<DecisionTreeConfig>): DecisionTreeConfig {
  return { ...defaultDecisionTreeConfig(), ...overrides }
}

/**
 * 自チーム未所有の最寄りノードをBFSで探索。中立ノードを優先する(見つかり次第即採用、
 * BFSなので必然的に最寄りの中立になる)。中立が一つも無い場合のみ、最初に見つかった
 * (=最寄りの)敵所有ノードで妥協する。マップは単一連結成分保証(§2.2)のため、
 * 自チーム以外が何かしら所有しているノードが存在する限り必ず見つかる。
 */
function findNearestUnclaimedNode(state: GameState, unit: UnitState): number | null {
  const visited = new Set<number>([unit.pos.to])
  let frontier = [unit.pos.to]
  let nearestEnemyOwned: number | null = null

  while (frontier.length > 0) {
    const nextFrontier: number[] = []
    for (const nodeIdx of frontier) {
      for (const n of state.neighbors[nodeIdx]) {
        if (visited.has(n)) continue
        visited.add(n)
        const owner = state.nodes[n].owner
        if (owner === null) return n
        if (owner !== unit.teamId && nearestEnemyOwned === null) nearestEnemyOwned = n
        nextFrontier.push(n)
      }
    }
    frontier = nextFrontier
  }

  return nearestEnemyOwned
}

const RING_SAFE_BONUS = 1000

/**
 * ユーザー要望による手動の判断木bot。優先順位付きのif/elseチェーンとして実装する
 * (§11.3どおり攻撃ヘッドと移動ヘッドはほぼ独立に決定する)。リング外の回避を最優先とする
 * (ユーザー要望: 「リング外を優先度高めに避ける」):
 *   1. リング退避: 現在地が安全圏外なら、HPや戦闘状況に関わらずリング中心へ最優先で戻る
 *      (射程内に敵がいれば移動中も反撃は続ける)。
 *   2. 退避: HPが`fleeHpFraction`未満かつ視認中の敵がいれば、その敵から最も離れる方向へ
 *      (現在の安全圏内に留まれる候補を優先)。反撃はしない。
 *   3. 交戦: 射程内に敵がいればその場に留まり(静止時の指向性攻撃力ボーナスを活かす)攻撃する。
 *   4. 追跡: 視認中(射程外)の敵がいればその方向へ1歩。
 *   5. テリトリー拡大: 上記に該当しなければ自チーム未所有の最寄りノードへ。
 *   6. フォールバック: 対象が見つからなければidle(simの探索フォールバック任せ)。
 */
export function decideCommands(
  state: GameState,
  unitIds: number[],
  config: DecisionTreeConfig = defaultDecisionTreeConfig(),
): Map<number, UnitDecision> {
  const decisions = new Map<number, UnitDecision>()

  for (const unitId of unitIds) {
    const unit = state.units.find((u) => u.id === unitId)
    if (!unit || !unit.alive) continue

    const visibleEnemies = computeVisibleEnemies(state, unit)
    const inRangeEnemies = visibleEnemies.filter((e) => e.dist <= state.config.attackRange)
    const nearestEnemy = visibleEnemies[0] ?? null
    const hpFraction = unit.hp / state.config.unitHP
    const selfWorldPos = unitWorldPos(state, unit)
    const outsideRing = worldDistBetween(selfWorldPos, state.ring.centerWorld) > state.ring.activeRadius

    let attackTarget: number | null = inRangeEnemies[0]?.unit.id ?? null
    let command: MoveCommand

    if (outsideRing) {
      command = pickBestDirection(state, unit, (candidate) => -worldDistBetween(candidate, state.ring.centerWorld))
    } else if (hpFraction < config.fleeHpFraction && nearestEnemy) {
      const enemyWorldPos = unitWorldPos(state, nearestEnemy.unit)
      command = pickBestDirection(state, unit, (candidate) => {
        const inRing = worldDistBetween(candidate, state.ring.centerWorld) <= state.ring.activeRadius
        return (inRing ? RING_SAFE_BONUS : 0) + worldDistBetween(candidate, enemyWorldPos)
      })
      attackTarget = null
    } else if (inRangeEnemies.length > 0) {
      command = { type: 'moveTo', node: unit.pos.to }
    } else if (nearestEnemy) {
      const enemyWorldPos = unitWorldPos(state, nearestEnemy.unit)
      command = pickBestDirection(state, unit, (candidate) => -worldDistBetween(candidate, enemyWorldPos))
    } else {
      const target = findNearestUnclaimedNode(state, unit)
      command = target !== null ? { type: 'moveTo', node: target } : { type: 'idle' }
    }

    decisions.set(unitId, { command, attackTarget })
  }

  return decisions
}
