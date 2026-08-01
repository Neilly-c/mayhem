import type { GameState, UnitState } from './types'
import { DIRECTIONS, axialAdd } from './hexgrid'
import { findPath } from './pathfinding'
import { deriveRng, randInt } from './rng'

/**
 * Read-phase output: everything needed to advance one unit's position, computed purely from
 * the pre-tick state (§4.2). `path` is always relative to `to` — path[0] is the hop *after*
 * arriving at `to`, so continuing mid-edge never needs to touch it.
 */
export interface MovementIntent {
  unitId: number
  wait: boolean
  from: number
  to: number
  progress: number
  speed: number
  destination: number | null
  path: number[] | null
}

function computeSpeed(state: GameState, fromIdx: number, toIdx: number, unit: UnitState): number {
  const fromNode = state.nodes[fromIdx]
  const toNode = state.nodes[toIdx]
  const ownedBySelf = fromNode.owner === unit.teamId && toNode.owner === unit.teamId
  const territoryMult = ownedBySelf ? 1 + state.config.territoryMoveBonus : 1
  // ユーザー要望: speedBoostアビリティ発動中は移動速度がi倍になる。
  const speedBoostMult =
    unit.ability === 'speedBoost' && unit.abilityActiveTicksRemaining > 0 ? state.config.speedBoostMult : 1
  return state.config.baseSpeed * territoryMult * speedBoostMult
}

/** §5 フォールバック: 指令未介入時は到達可能な通行可能ノードをランダムに探索目的地とする。 */
function pickExploreDestination(state: GameState, unit: UnitState): number | null {
  const candidates: number[] = []
  for (let i = 0; i < state.nodes.length; i++) {
    if (state.nodes[i].passable && i !== unit.pos.to) candidates.push(i)
  }
  if (candidates.length === 0) return null
  const rng = deriveRng(state.seed, `explore:${unit.id}:${state.tick}`)
  return candidates[randInt(rng, candidates.length)]
}

function waitIntent(
  unit: UnitState,
  destination: number | null,
  path: number[] | null,
): MovementIntent {
  return {
    unitId: unit.id,
    wait: true,
    from: unit.pos.from,
    to: unit.pos.to,
    progress: unit.pos.progress,
    speed: 0,
    destination,
    path,
  }
}

function computeDirectionIntent(
  state: GameState,
  unit: UnitState,
  dir: number,
  claimedTo: ReadonlySet<number>,
): MovementIntent {
  if (unit.pos.from !== unit.pos.to) {
    // Mid-edge: low-level direction commands only take effect once standing on a node.
    return {
      unitId: unit.id,
      wait: false,
      from: unit.pos.from,
      to: unit.pos.to,
      progress: unit.pos.progress,
      speed: computeSpeed(state, unit.pos.from, unit.pos.to, unit),
      destination: null,
      path: null,
    }
  }

  const node = state.nodes[unit.pos.to]
  const target = axialAdd({ q: node.q, r: node.r }, DIRECTIONS[dir])
  const targetIdx = state.neighbors[unit.pos.to].find((n) => {
    const tn = state.nodes[n]
    return tn.q === target.q && tn.r === target.r
  })

  // ユーザー要望: 同一ノードへの複数ユニット共存禁止(味方も含む)。moveDirectionは経路探索を
  // 持たない生の1手コマンドなので、隣接ノードが既に占有されている場合は壁と同様その場で待機する
  // (`buildActionMask`側でもこの状況を非合法手としてマスクする — §11.3)。
  if (targetIdx === undefined || claimedTo.has(targetIdx)) {
    return waitIntent(unit, null, null)
  }

  return {
    unitId: unit.id,
    wait: false,
    from: unit.pos.to,
    to: targetIdx,
    progress: 0,
    speed: computeSpeed(state, unit.pos.to, targetIdx, unit),
    destination: null,
    path: null,
  }
}

function computePathIntent(state: GameState, unit: UnitState, claimedTo: ReadonlySet<number>): MovementIntent {
  let destination = unit.destination
  let path = unit.path

  if (unit.command.type === 'moveTo') {
    if (destination !== unit.command.node) {
      destination = unit.command.node
      path = null
    }
  } else if (destination === null) {
    destination = pickExploreDestination(state, unit)
    path = null
  }

  if (destination === null) return waitIntent(unit, null, null)

  if (path === null) {
    path = findPath(state.nodes, state.neighbors, unit.pos.to, destination, claimedTo)
    if (path === null) {
      // Unreachable (walled off) or currently occupied — retry next tick per §10 rather than
      // getting permanently stuck; a blocking unit may well have moved away by then.
      return waitIntent(unit, destination, null)
    }
  }

  const midEdge = unit.pos.from !== unit.pos.to

  if (midEdge && path.length > 0 && path[0] === unit.pos.from) {
    // §5 辺の途中での指令変更: the shortest route now backtracks, so reverse the current edge.
    const from = unit.pos.to
    const to = unit.pos.from
    return {
      unitId: unit.id,
      wait: false,
      from,
      to,
      progress: 1 - unit.pos.progress,
      speed: computeSpeed(state, from, to, unit),
      destination,
      path: path.slice(1),
    }
  }

  if (midEdge) {
    // Continue toward `to`; path (relative to `to`) is untouched. `to` is already exclusively
    // claimed by this unit (occupancy is checked before a unit ever commits to a new `to`), so no
    // re-check is needed here.
    return {
      unitId: unit.id,
      wait: false,
      from: unit.pos.from,
      to: unit.pos.to,
      progress: unit.pos.progress,
      speed: computeSpeed(state, unit.pos.from, unit.pos.to, unit),
      destination,
      path,
    }
  }

  if (path.length === 0) {
    // Standing at the destination already.
    return waitIntent(unit, destination, path)
  }

  let nextHop = path[0]
  let remainingPath = path.slice(1)

  // ユーザー要望: 次に進もうとしているノードが他ユニットに占有されていたら、そこから再探索する。
  // まだ辺に乗っていない(stationary)段階での発見なので「直前のノードへ戻る」必要はなく、
  // ここでその場から新しい経路を引き直すだけでよい(バックトラックが最短になる場合は、
  // 上のmidEdge分岐が次tick以降で自然にそれを検出し、既存の辺反転ロジックが適用される)。
  if (claimedTo.has(nextHop)) {
    const rerouted = findPath(state.nodes, state.neighbors, unit.pos.to, destination, claimedTo)
    if (rerouted === null || rerouted.length === 0) {
      // No alternate route right now (or already effectively at destination) — wait and retry.
      return waitIntent(unit, destination, null)
    }
    nextHop = rerouted[0]
    remainingPath = rerouted.slice(1)
  }

  return {
    unitId: unit.id,
    wait: false,
    from: unit.pos.to,
    to: nextHop,
    progress: 0,
    speed: computeSpeed(state, unit.pos.to, nextHop, unit),
    destination,
    path: remainingPath,
  }
}

/**
 * Read phase (§4.2): compute one unit's movement intent from the pre-tick state only.
 * `claimedTo`: ユーザー要望 — 同一ノードへの複数ユニット共存を禁止するための、現在確定している
 * (このユニット自身を除く)占有先ノード集合。`sim.ts`がユニットを`(teamId,unitId)`順に1体ずつ
 * compute→applyし、確定するたびに更新しながら渡す(先着順の決定的な衝突解決)。
 */
export function computeMovementIntent(
  state: GameState,
  unit: UnitState,
  claimedTo: ReadonlySet<number>,
): MovementIntent | null {
  if (!unit.alive) return null
  const intent =
    unit.command.type === 'moveDirection'
      ? computeDirectionIntent(state, unit, unit.command.dir, claimedTo)
      : computePathIntent(state, unit, claimedTo)

  // 最終防衛線: どの分岐由来であっても、移動先が(発見時点で)占有済みノードであれば必ず待機に
  // 差し替える。個別分岐の再探索ロジックに漏れがあっても、この不変条件だけは常に守られる。
  if (intent.to !== intent.from && claimedTo.has(intent.to)) {
    return waitIntent(unit, intent.destination, null)
  }
  return intent
}

/**
 * Apply phase (§4.2): mutate the unit's position/cache according to its intent. Returns every
 * node index the unit arrived at during this tick's resolution, in order — usually 0 or 1 under
 * normal configs, but the overshoot loop below can consume more than one hop in a single tick.
 * A node arrived at mid-resolution and immediately left again (because there was more path and
 * leftover speed to spend) never shows up as `unit.pos.from === unit.pos.to`, so callers that
 * need "did this unit touch that node this tick at all" (§6's instant neutral-node capture on
 * mere pass-through, not just stopping) can't derive it from the final `pos` alone.
 */
export function applyMovementIntent(
  state: GameState,
  unit: UnitState,
  intent: MovementIntent,
  claimedTo: ReadonlySet<number>,
): number[] {
  unit.destination = intent.destination

  if (intent.wait) {
    unit.path = intent.path
    return []
  }

  let from = intent.from
  let to = intent.to
  let progress = intent.progress + intent.speed
  let path = intent.path
  const visited: number[] = []

  while (progress >= 1) {
    progress -= 1
    const arrived = to
    visited.push(arrived)
    from = arrived
    to = arrived
    if (path === null || path.length === 0) {
      progress = 0
      break
    }
    const nextHop = path[0]
    // ユーザー要望: 1tick内で複数ノードを跨ぐ(オーバーシュート)最中に次のホップが他ユニットに
    // 占有されていたら、直前に到着したノード(`arrived`、既に`from===to`としてstationary)で
    // 止まる。`path`をnullにして次tickのcomputePathIntentに再探索させる。
    if (claimedTo.has(nextHop)) {
      progress = 0
      path = null
      break
    }
    path = path.slice(1)
    to = nextHop
    progress += computeSpeed(state, from, to, unit)
  }

  unit.pos = { from, to, progress }
  unit.path = path

  if (from === to && from === unit.destination) {
    unit.destination = null
    unit.path = null
  }

  return visited
}
