import type { AbilityKind, NodeState, SimConfig, TeamState, UnitState } from './types'
import { world } from './hexgrid'
import { deriveRng, randInt, type RngFn } from './rng'

/** ユーザー要望: ユニットごとに開始時1種ランダム割り振り(シード付き、チーム内重複可)。 */
const ABILITY_KINDS: readonly AbilityKind[] = ['paintball', 'laser', 'damageShield', 'speedBoost', 'chainDamage']

function shuffle<T>(arr: T[], rng: RngFn): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

/** ユーザー要望: チーム同士の初期配置が接近し過ぎないよう、先頭2チームはマップ中央付近
 * (`centerTeamCount`個の方位セクタのうち中心に最も近いノード)へ、残りのチームは外周部
 * (残りのセクタのうち中心から最も遠いノード)へ、それぞれ方位を均等分割して配置する。
 * `teamCount<=2`なら全チームが中央側の扱いになる(外周チームが0になるため、周方向分割は行わない)。 */
function pickSectorSpawn(
  passableIndices: number[],
  occupied: Set<number>,
  nodes: NodeState[],
  cx: number,
  cy: number,
  predicate: (angle: number) => boolean,
  pickFarthest: boolean,
): number {
  let bestIdx = -1
  let bestDist = pickFarthest ? -Infinity : Infinity
  for (const i of passableIndices) {
    if (occupied.has(i)) continue
    const w = world(nodes[i])
    let angle = Math.atan2(w.y - cy, w.x - cx)
    if (angle < 0) angle += Math.PI * 2
    if (!predicate(angle)) continue
    const dist = Math.hypot(w.x - cx, w.y - cy)
    if (pickFarthest ? dist > bestDist : dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * §3.1 スポーン: 先頭2チーム(`centerTeamCount`)はマップ中央付近、残りのチームは外周付近へ、
 * それぞれ角度セクタで均等分散させる。同一チームの残りのユニットはBFSで最寄りの未使用ノードへ
 * 確定的に配置する。
 */
export function createTeamsAndUnits(
  seed: number,
  config: SimConfig,
  nodes: NodeState[],
  neighbors: number[][],
): { teams: TeamState[]; units: UnitState[] } {
  const passableIndices: number[] = []
  for (let i = 0; i < nodes.length; i++) if (nodes[i].passable) passableIndices.push(i)

  if (passableIndices.length < config.teamCount * config.unitsPerTeam) {
    throw new Error('Not enough passable nodes to spawn all teams')
  }

  let cx = 0
  let cy = 0
  for (const i of passableIndices) {
    const w = world(nodes[i])
    cx += w.x
    cy += w.y
  }
  cx /= passableIndices.length
  cy /= passableIndices.length

  const occupied = new Set<number>()
  const spawnRng = deriveRng(seed, 'spawn')
  const abilityRng = deriveRng(seed, 'ability')

  const centerTeamCount = Math.min(1, config.teamCount)
  const peripheryTeamCount = config.teamCount - centerTeamCount

  const teams: TeamState[] = []
  const units: UnitState[] = []
  let unitId = 0

  for (let teamId = 0; teamId < config.teamCount; teamId++) {
    const isCenterTeam = teamId < centerTeamCount
    const sectorIndex = isCenterTeam ? teamId : teamId - centerTeamCount
    const sectorCount = isCenterTeam ? centerTeamCount : peripheryTeamCount
    const sectorStart = (sectorIndex / sectorCount) * Math.PI * 2
    const sectorEnd = ((sectorIndex + 1) / sectorCount) * Math.PI * 2

    let primary = pickSectorSpawn(
      passableIndices,
      occupied,
      nodes,
      cx,
      cy,
      (angle) => angle >= sectorStart && angle < sectorEnd,
      !isCenterTeam,
    )
    // Fallback for sparse maps where no unoccupied node falls in this exact sector.
    if (primary === -1) primary = pickSectorSpawn(passableIndices, occupied, nodes, cx, cy, () => true, !isCenterTeam)
    if (primary === -1) throw new Error(`Could not find a spawn node for team ${teamId}`)

    const spawnNodes = [primary]
    occupied.add(primary)

    const visited = new Set<number>([primary])
    let frontier = [primary]
    while (spawnNodes.length < config.unitsPerTeam && frontier.length > 0) {
      const nextFrontier: number[] = []
      const candidates: number[] = []
      for (const node of frontier) {
        for (const n of neighbors[node]) {
          if (visited.has(n)) continue
          visited.add(n)
          nextFrontier.push(n)
          if (!occupied.has(n)) candidates.push(n)
        }
      }
      shuffle(candidates, spawnRng)
      for (const c of candidates) {
        if (spawnNodes.length >= config.unitsPerTeam) break
        spawnNodes.push(c)
        occupied.add(c)
      }
      frontier = nextFrontier
    }

    if (spawnNodes.length < config.unitsPerTeam) {
      throw new Error(`Could not find enough spawn nodes near team ${teamId}`)
    }

    teams.push({ id: teamId, alive: true, eliminatedAtTick: null, killCount: 0 })
    for (const nodeIdx of spawnNodes) {
      units.push({
        id: unitId++,
        teamId,
        pos: { from: nodeIdx, to: nodeIdx, progress: 0 },
        hp: config.unitHP,
        alive: true,
        command: { type: 'idle' },
        attackTarget: null,
        destination: null,
        path: null,
        lastDamagedByTeamId: null,
        ability: ABILITY_KINDS[randInt(abilityRng, ABILITY_KINDS.length)],
        abilityCooldownRemaining: 0,
        abilityActiveTicksRemaining: 0,
        abilityCommand: { type: 'none' },
      })
    }
  }

  return { teams, units }
}
