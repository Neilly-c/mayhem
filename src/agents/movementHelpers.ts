import type { GameState, MoveCommand, UnitState, Vec2 } from '../sim'
import { DIRECTIONS, axialAdd, unitWorldPos, world, worldDistBetween } from '../sim'

/**
 * 現在ノードの6近傍のうち`scoreCandidate`が最大のものへ1歩移動する(`moveDirection`)。壁/地図端で
 * 候補が無ければ`idle`にフォールバック。辺の途中(mid-edge)の間は`moveDirection`は無視される
 * (movement.tsの仕様)ため、無害な`dir:0`をそのまま返して現在の辺の進行を妨げない
 * (`idle`を返すと、destinationが無い場合にsimの探索フォールバックが誤って発火してしまうため使わない)。
 * `raiderBot`が追跡(固定目的地を持たない、方向へ1歩判断)に使う。
 * リング退避は目的地が明確(安全圏内の最寄りノード)なので、壁を回避できる`findNearestSafeNode`
 * + `moveTo`(A*)を使う — こちらの貪欲法は使わない(壁の凹地形で足踏み/往復してしまうため)。
 */
export function pickBestDirection(
  state: GameState,
  unit: UnitState,
  scoreCandidate: (candidateWorldPos: Vec2) => number,
): MoveCommand {
  if (unit.pos.from !== unit.pos.to) return { type: 'moveDirection', dir: 0 }

  const node = state.nodes[unit.pos.to]
  let bestDir: 0 | 1 | 2 | 3 | 4 | 5 | null = null
  let bestScore = -Infinity

  for (let dir = 0; dir <= 5; dir++) {
    const target = axialAdd({ q: node.q, r: node.r }, DIRECTIONS[dir])
    const neighborIdx = state.neighbors[unit.pos.to].find(
      (n) => state.nodes[n].q === target.q && state.nodes[n].r === target.r,
    )
    if (neighborIdx === undefined) continue

    const score = scoreCandidate(world(state.nodes[neighborIdx]))
    if (score > bestScore) {
      bestScore = score
      bestDir = dir as 0 | 1 | 2 | 3 | 4 | 5
    }
  }

  return bestDir !== null ? { type: 'moveDirection', dir: bestDir } : { type: 'idle' }
}

/**
 * ユーザー要望: リング退避を`pickBestDirection`の貪欲な隣接ノード選択(壁を知覚できず、壁の凹地形で
 * 足踏み/往復してしまう)からA*経路探索(`moveTo`)へ切り替える。BFSでホップ数昇順に走査し、
 * 現在の安全円(`ring.activeRadius`)内に入る最初の(=自分から最も近い)ノードを目的地として返す。
 * `moveTo`側の`findPath`(A*)が壁を回避した経路を組んでくれるので、このヘルパー自体は
 * 「どこへ向かうべきか」だけを決め、「どう辿り着くか」は関与しない。
 * `expanderBot`/`guardianBot`/`raiderBot`の3つ全てが共有する。
 */
export function findNearestSafeNode(state: GameState, unit: UnitState): number | null {
  if (worldDistBetween(unitWorldPos(state, unit), state.ring.centerWorld) <= state.ring.activeRadius) {
    return unit.pos.to
  }

  const visited = new Set<number>([unit.pos.to])
  let frontier = [unit.pos.to]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const idx of frontier) {
      for (const n of state.neighbors[idx]) {
        if (visited.has(n)) continue
        visited.add(n)
        if (worldDistBetween(world(state.nodes[n]), state.ring.centerWorld) <= state.ring.activeRadius) return n
        next.push(n)
      }
    }
    frontier = next
  }
  return null
}

/**
 * ユーザー要望: 「即時フォールバック」(目的地が塞がっていたら次の候補へ)を導入するにあたり、
 * フォールバック先が同じ塞がっているノードに再収束しないよう、他ユニットが現在いる
 * (`pos.to`)ノードは候補から除外する(自分自身は除く)。占領/防衛系の探索(`findNearestUnclaimedNode`
 * /`findNearestOwnNode`/`guardianBot`の`findThreatenedOwnNode`)が共有する。BFSの走査自体は
 * 占有ノードも経由して続ける(そこを最終目的地として選ばないだけ) — 占有ノードの先にしか
 * 候補が無いケースを取りこぼさないため。
 */
export function otherUnitOccupiedNodes(state: GameState, unit: UnitState): Set<number> {
  const occupied = new Set<number>()
  for (const u of state.units) {
    if (u.alive && u.id !== unit.id) occupied.add(u.pos.to)
  }
  return occupied
}

/**
 * ユーザー要望: 陣営の目的がマップ占領率になったため、自チーム未所有の最寄りノードをBFSで探す
 * 「拡張」判断は複数の性格のbotが共有する(`expanderBot`/`guardianBot`/`raiderBot`)。中立ノードを
 * 優先する(見つかり次第即採用、BFSなので必然的に最寄りの中立になる — `territory.ts`が中立ノードは
 * 通過するだけでも即座に奪取するため、道中で自然に塗りながら進める)。中立が一つも無い場合のみ、
 * 最初に見つかった(=最寄りの)敵所有ノードで妥協する(こちらは`captureTicks`分の滞在が要る)。
 * マップは単一連結成分保証(§2.2)のため、自チーム以外が何かしら所有しているノードが存在する限り
 * 必ず見つかる。他ユニットが現在いるノードは候補から除外する(`otherUnitOccupiedNodes`) —
 * そうしないと複数ユニットが同じ目的地に収束して片方が塞がれたまま動けなくなる
 * (占領済みで候補から外れるのは移動が完了してからなので、収束自体はここでは防げないが、
 * 既に誰かが着いている=占有中のノードへは最初から向かわせないことで、後続ユニットは自然に
 * 次善の候補へ分散する)。
 */
export function findNearestUnclaimedNode(state: GameState, unit: UnitState): number | null {
  const occupied = otherUnitOccupiedNodes(state, unit)
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
        if (owner === null) {
          if (!occupied.has(n)) return n
        } else if (owner !== unit.teamId && nearestEnemyOwned === null && !occupied.has(n)) {
          nearestEnemyOwned = n
        }
        nextFrontier.push(n)
      }
    }
    frontier = nextFrontier
  }

  return nearestEnemyOwned
}

/** BFSで自チーム所有の最寄りノードを探す。所有ノードが一つも無ければnull。`guardianBot`が
 * 負傷時の帰還先(自陣territoryRegenRateでの回復)を選ぶのに使う。他ユニットが現在いるノードは
 * 候補から除外する(`otherUnitOccupiedNodes`、`findNearestUnclaimedNode`と同じ理由)。 */
export function findNearestOwnNode(state: GameState, unit: UnitState): number | null {
  if (state.nodes[unit.pos.to].owner === unit.teamId) return unit.pos.to

  const occupied = otherUnitOccupiedNodes(state, unit)
  const visited = new Set<number>([unit.pos.to])
  let frontier = [unit.pos.to]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const idx of frontier) {
      for (const n of state.neighbors[idx]) {
        if (visited.has(n)) continue
        visited.add(n)
        if (state.nodes[n].owner === unit.teamId && !occupied.has(n)) return n
        next.push(n)
      }
    }
    frontier = next
  }
  return null
}
