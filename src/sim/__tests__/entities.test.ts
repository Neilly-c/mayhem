import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import { generateMap } from '../mapgen'
import { world } from '../hexgrid'
import { createTeamsAndUnits } from '../entities'

// wallThreshold: 0 guarantees every generated node is passable, giving a large fully-connected
// hex disk so sector-based spawn placement isn't starved for candidates.
function makeMapAndConfig(overrides?: Partial<Parameters<typeof createConfig>[0]>) {
  const config = createConfig({ mapRadius: 10, wallThreshold: 0, ...overrides })
  const { nodes, neighbors } = generateMap(1, config)
  return { config, nodes, neighbors }
}

function centroid(nodes: ReturnType<typeof generateMap>['nodes']) {
  let cx = 0
  let cy = 0
  for (const n of nodes) {
    const w = world(n)
    cx += w.x
    cy += w.y
  }
  return { cx: cx / nodes.length, cy: cy / nodes.length }
}

describe('createTeamsAndUnits: spawn placement', () => {
  it('assigns exactly unitsPerTeam units per team, all on distinct passable nodes', () => {
    const { config, nodes, neighbors } = makeMapAndConfig({ teamCount: 5, unitsPerTeam: 3 })
    const { teams, units } = createTeamsAndUnits(1, config, nodes, neighbors)

    expect(teams).toHaveLength(5)
    expect(units).toHaveLength(15)
    for (let teamId = 0; teamId < 5; teamId++) {
      expect(units.filter((u) => u.teamId === teamId)).toHaveLength(3)
    }
    const occupiedNodes = units.map((u) => u.pos.to)
    expect(new Set(occupiedNodes).size).toBe(occupiedNodes.length)
    for (const u of units) expect(nodes[u.pos.to].passable).toBe(true)
  })

  it('ユーザー要望: places the center team(s) nearer the map center than the remaining (periphery) teams', () => {
    const { config, nodes, neighbors } = makeMapAndConfig({ teamCount: 6, unitsPerTeam: 1 })
    const { units } = createTeamsAndUnits(1, config, nodes, neighbors)
    const { cx, cy } = centroid(nodes)

    const distFromCenter = (nodeIdx: number) => {
      const w = world(nodes[nodeIdx])
      return Math.hypot(w.x - cx, w.y - cy)
    }

    // centerTeamCount is currently 1 (team 0); the rest are periphery teams.
    const centerTeamDists = [0].map((teamId) => distFromCenter(units.find((u) => u.teamId === teamId)!.pos.to))
    const peripheryTeamDists = [1, 2, 3, 4, 5].map((teamId) => distFromCenter(units.find((u) => u.teamId === teamId)!.pos.to))

    const maxCenterDist = Math.max(...centerTeamDists)
    const minPeripheryDist = Math.min(...peripheryTeamDists)
    expect(maxCenterDist).toBeLessThan(minPeripheryDist)
  })

  it('spreads periphery teams across distinct angular sectors around the center', () => {
    const { config, nodes, neighbors } = makeMapAndConfig({ teamCount: 6, unitsPerTeam: 1 })
    const { units } = createTeamsAndUnits(1, config, nodes, neighbors)
    const { cx, cy } = centroid(nodes)

    const angleOf = (nodeIdx: number) => {
      const w = world(nodes[nodeIdx])
      let angle = Math.atan2(w.y - cy, w.x - cx)
      if (angle < 0) angle += Math.PI * 2
      return angle
    }

    // 5 periphery teams (1,2,3,4,5) -> fifth-turn sectors.
    const peripherySectors = [1, 2, 3, 4, 5].map((teamId) => {
      const angle = angleOf(units.find((u) => u.teamId === teamId)!.pos.to)
      return Math.floor((angle / (Math.PI * 2)) * 5)
    })
    expect(new Set(peripherySectors).size).toBe(5)
  })

  it('does not throw when teamCount is 2', () => {
    const { config, nodes, neighbors } = makeMapAndConfig({ teamCount: 2, unitsPerTeam: 2 })
    const { teams, units } = createTeamsAndUnits(1, config, nodes, neighbors)
    expect(teams).toHaveLength(2)
    expect(units).toHaveLength(4)
  })

  it('does not throw when teamCount is 1', () => {
    const { config, nodes, neighbors } = makeMapAndConfig({ teamCount: 1, unitsPerTeam: 2 })
    const { teams, units } = createTeamsAndUnits(1, config, nodes, neighbors)
    expect(teams).toHaveLength(1)
    expect(units).toHaveLength(2)
  })

  it('is deterministic for a given seed', () => {
    const { config, nodes, neighbors } = makeMapAndConfig({ teamCount: 6, unitsPerTeam: 3 })
    const a = createTeamsAndUnits(7, config, nodes, neighbors)
    const b = createTeamsAndUnits(7, config, nodes, neighbors)
    expect(a).toEqual(b)
  })
})
