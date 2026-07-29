import type { NodeState, SimConfig, TeamState, UnitState } from './types'
import { world } from './hexgrid'
import { deriveRng, type RngFn } from './rng'

function shuffle<T>(arr: T[], rng: RngFn): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

/**
 * §3.1 スポーン: 各チームをマップ外周付近へ角度セクタで均等分散させ、同一チームの
 * 残り2体はBFSで最寄りの未使用ノードへ確定的に配置する。
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

  const teams: TeamState[] = []
  const units: UnitState[] = []
  let unitId = 0

  for (let teamId = 0; teamId < config.teamCount; teamId++) {
    const sectorStart = (teamId / config.teamCount) * Math.PI * 2
    const sectorEnd = ((teamId + 1) / config.teamCount) * Math.PI * 2

    const farthestUnoccupied = (predicate: (angle: number) => boolean): number => {
      let bestIdx = -1
      let bestDist = -Infinity
      for (const i of passableIndices) {
        if (occupied.has(i)) continue
        const w = world(nodes[i])
        let angle = Math.atan2(w.y - cy, w.x - cx)
        if (angle < 0) angle += Math.PI * 2
        if (!predicate(angle)) continue
        const dist = Math.hypot(w.x - cx, w.y - cy)
        if (dist > bestDist) {
          bestDist = dist
          bestIdx = i
        }
      }
      return bestIdx
    }

    let primary = farthestUnoccupied((angle) => angle >= sectorStart && angle < sectorEnd)
    // Fallback for sparse maps where no unoccupied node falls in this exact sector.
    if (primary === -1) primary = farthestUnoccupied(() => true)
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
      })
    }
  }

  return { teams, units }
}
