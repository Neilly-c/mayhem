import type { GameState, MoveCommand, UnitState } from '../sim'
import { unitWorldPos, world, worldDistBetween } from '../sim'
import { computeVisibleEnemies } from '../env'
import type { UnitDecision } from './scriptedBot'
import { pickBestDirection } from './movementHelpers'

export interface SurvivalBotConfig {
  /** Below this HP fraction, break off from holding ground to retreat to own territory and heal. */
  healHpFraction: number
  /** How strongly elevation (terrain advantage) is weighted against distance-to-anchor when picking a
   * point to hold, in world-distance units per elevation unit. */
  elevationWeight: number
  /** Hex-hop radius used both to search for a stronghold point around the ring's disclosed next
   * center, and (once there) to search for nearby territory to claim. */
  holdHops: number
}

export function defaultSurvivalBotConfig(): SurvivalBotConfig {
  return { healHpFraction: 0.5, elevationWeight: 6, holdHops: 3 }
}

export function createSurvivalBotConfig(overrides?: Partial<SurvivalBotConfig>): SurvivalBotConfig {
  return { ...defaultSurvivalBotConfig(), ...overrides }
}

function isStationaryAt(unit: UnitState, nodeIdx: number): boolean {
  return unit.pos.from === nodeIdx && unit.pos.to === nodeIdx
}

/**
 * ある地点が既に他チームに押さえられているか判定する。所有権(`node.owner`)が他チームなら
 * 明確に「取られている」。所有権がまだ移っていなくても、その地点の攻撃範囲内に敵ユニットが
 * 実在すれば、そこへ向かった瞬間に交戦圏内に入ってしまうため同様に危険とみなす。
 *
 * ユーザー要望: 敵チームとの相対位置を見ずに標高だけで拠点を選ぶと、同じロジックを使う
 * チームが複数いた場合に同じ高台へ収束して共倒れになる。誰が相手かは問わず(相手チームを
 * 特定せず)全ての敵チームを対象に判定することで、複数チームの同時収束にも対応する。
 */
function isThreatenedByEnemy(state: GameState, nodeIdx: number, teamId: number): boolean {
  const node = state.nodes[nodeIdx]
  if (node.owner !== null && node.owner !== teamId) return true

  const pos = world(node)
  return state.units.some(
    (u) => u.alive && u.teamId !== teamId && worldDistBetween(unitWorldPos(state, u), pos) <= state.config.attackRange,
  )
}

/**
 * 「予告リング中心(§8で開示済みの唯一の未来情報)かつ地形効果有利な地点」を選ぶ: 中心ノードから
 * `holdHops`以内をBFS走査し、中心への近さと標高の合成スコア(標高*elevationWeight - 中心からの距離)
 * が最大のノードを返す。中心ノード自身をスコア0地点の候補として含めるので、周辺が全て低地でも
 * 最終的に中心そのものが選ばれる。
 *
 * `isThreatenedByEnemy`で安全な候補を優先する: 一番スコアが高い地点が既に他チームに取られて
 * いれば、その地点は候補から外し、安全な中で次善のスコアの地点を探す(ユーザー要望)。
 * `holdHops`以内が全て危険な場合(激戦区の map 中央など)は、安全を諦めて最良スコアの地点へ
 * 向かう他ない — リングは待ってくれないので、動かないより次善の地点へ向かう方がまだ良い。
 */
function findStronghold(state: GameState, teamId: number, config: SurvivalBotConfig): number {
  const anchorIdx = state.ring.nextCenter
  const anchorWorld = world(state.nodes[anchorIdx])
  const scoreOf = (nodeIdx: number, dist: number) => state.nodes[nodeIdx].elevation * config.elevationWeight - dist

  let bestOverall = anchorIdx
  let bestOverallScore = scoreOf(anchorIdx, 0)
  let bestSafe: number | null = isThreatenedByEnemy(state, anchorIdx, teamId) ? null : anchorIdx
  let bestSafeScore = bestSafe !== null ? bestOverallScore : -Infinity

  const visited = new Set<number>([anchorIdx])
  let frontier = [anchorIdx]
  for (let hop = 0; hop < config.holdHops && frontier.length > 0; hop++) {
    const next: number[] = []
    for (const idx of frontier) {
      for (const n of state.neighbors[idx]) {
        if (visited.has(n)) continue
        visited.add(n)
        next.push(n)

        const dist = worldDistBetween(world(state.nodes[n]), anchorWorld)
        const score = scoreOf(n, dist)
        if (score > bestOverallScore) {
          bestOverallScore = score
          bestOverall = n
        }
        if (score > bestSafeScore && !isThreatenedByEnemy(state, n, teamId)) {
          bestSafeScore = score
          bestSafe = n
        }
      }
    }
    frontier = next
  }

  return bestSafe ?? bestOverall
}

/** BFSで自チーム所有の最寄りノードを探す。所有ノードが一つも無ければnull。 */
function findNearestOwnNode(state: GameState, unit: UnitState): number | null {
  if (state.nodes[unit.pos.to].owner === unit.teamId) return unit.pos.to

  const visited = new Set<number>([unit.pos.to])
  let frontier = [unit.pos.to]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const idx of frontier) {
      for (const n of state.neighbors[idx]) {
        if (visited.has(n)) continue
        visited.add(n)
        if (state.nodes[n].owner === unit.teamId) return n
        next.push(n)
      }
    }
    frontier = next
  }
  return null
}

/**
 * 拠点(`startIdx`)から`maxHops`以内で自チーム未所有の最寄りノードを探す(「そのポイント周辺を
 * 抑える」ための対象)。中立ノードを優先し、BFSなので必然的に最寄りの中立になる。中立が範囲内に
 * 一つも無ければ、最初に見つかった(=最寄りの)敵所有ノードで妥協する。全て自チーム所有ならnull。
 */
function findNearbyUnclaimedNode(
  state: GameState,
  startIdx: number,
  teamId: number,
  maxHops: number,
): number | null {
  const visited = new Set<number>([startIdx])
  let frontier = [startIdx]
  let nearestEnemyOwned: number | null = null

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: number[] = []
    for (const idx of frontier) {
      for (const n of state.neighbors[idx]) {
        if (visited.has(n)) continue
        visited.add(n)
        const owner = state.nodes[n].owner
        if (owner === null) return n
        if (owner !== teamId && nearestEnemyOwned === null) nearestEnemyOwned = n
        next.push(n)
      }
    }
    frontier = next
  }

  return nearestEnemyOwned
}

/**
 * ユーザー要望による生存優先bot(最寄り攻撃の`scriptedBot`とは別系統): 積極的な追撃はせず、拠点の
 * 確保と回復を優先する。優先順位:
 *   1. リング退避: 現在地が安全圏外なら、他のbotと同じくHPや戦況に関わらずリング中心へ最優先で戻る。
 *   2. 回復: HPが`healHpFraction`未満なら自チーム所有ノードへ戻り、着いたら静止して回復に専念する
 *      (自エリアが無ければ、まず3.と同じ拠点確保に向かう — 確保できればそこが回復エリアになる)。
 *   3. 拠点確保: 上記に該当しなければ「予告リング中心かつ地形(標高)有利な地点」(`findStronghold`)
 *      へ向かい、到達済みなら周辺`holdHops`以内の未確保ノードを1つずつ確保して支配域を固める。
 *      拠点は既に他チームに取られている(所有済み、または敵ユニットの攻撃範囲内)地点を避けて
 *      選ばれるため、同じロジックを使う複数チームが同じ高台へ収束して共倒れになりにくい。
 * 攻撃は独立ヘッドとして常に「射程内の最寄り敵」に反撃する(移動判断とは無関係。追撃はしない)。
 */
export function decideCommands(
  state: GameState,
  unitIds: number[],
  config: SurvivalBotConfig = defaultSurvivalBotConfig(),
): Map<number, UnitDecision> {
  const decisions = new Map<number, UnitDecision>()

  for (const unitId of unitIds) {
    const unit = state.units.find((u) => u.id === unitId)
    if (!unit || !unit.alive) continue

    const visibleEnemies = computeVisibleEnemies(state, unit)
    const inRangeEnemies = visibleEnemies.filter((e) => e.dist <= state.config.attackRange)
    const attackTarget = inRangeEnemies[0]?.unit.id ?? null

    const selfWorldPos = unitWorldPos(state, unit)
    const outsideRing = worldDistBetween(selfWorldPos, state.ring.centerWorld) > state.ring.activeRadius
    const hpFraction = unit.hp / state.config.unitHP

    let command: MoveCommand

    if (outsideRing) {
      command = pickBestDirection(state, unit, (candidate) => -worldDistBetween(candidate, state.ring.centerWorld))
    } else if (hpFraction < config.healHpFraction) {
      const ownNode = findNearestOwnNode(state, unit)
      if (ownNode === null) {
        command = { type: 'moveTo', node: findStronghold(state, unit.teamId, config) }
      } else if (isStationaryAt(unit, ownNode)) {
        command = { type: 'idle' }
      } else {
        command = { type: 'moveTo', node: ownNode }
      }
    } else {
      const stronghold = findStronghold(state, unit.teamId, config)
      if (isStationaryAt(unit, stronghold)) {
        const claim = findNearbyUnclaimedNode(state, stronghold, unit.teamId, config.holdHops)
        command = claim !== null ? { type: 'moveTo', node: claim } : { type: 'idle' }
      } else {
        command = { type: 'moveTo', node: stronghold }
      }
    }

    decisions.set(unitId, { command, attackTarget })
  }

  return decisions
}
