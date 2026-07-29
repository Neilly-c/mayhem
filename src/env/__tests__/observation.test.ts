import { describe, expect, it } from 'vitest'
import { createConfig, generateMap, initRingState } from '../../sim'
import type { GameState, SimConfig, UnitState } from '../../sim'
import { buildNodeIndex, buildObservation } from '../observation'
import { computeVisibleEnemies } from '../visibility'

function makeConfig(overrides?: Partial<SimConfig>): SimConfig {
  return createConfig({
    mapRadius: 5,
    wallThreshold: 0, // every node passable -> no wall-related flakiness in these tests
    teamCount: 2,
    unitsPerTeam: 3,
    maxVisibleEnemies: 3,
    patchHops: 2,
    visionRange: 100,
    attackRange: 2,
    ...overrides,
  })
}

function makeUnit(id: number, teamId: number, atNode: number, hp = 100): UnitState {
  return {
    id,
    teamId,
    pos: { from: atNode, to: atNode, progress: 0 },
    hp,
    alive: true,
    command: { type: 'idle' },
    attackTarget: null,
    destination: null,
    path: null,
    lastDamagedByTeamId: null,
  }
}

function makeState(seed: number, config: SimConfig, units: UnitState[]): GameState {
  const { nodes, neighbors } = generateMap(seed, config)
  return {
    seed,
    tick: 250,
    config,
    nodes,
    neighbors,
    teams: [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
    ],
    units,
    ring: initRingState(seed, config, nodes),
  }
}

const expectedVectorLength = (config: SimConfig): number => {
  const selfLen = 2 + 1 + 1 + 1 + 2 + 1 + 1 + 1 + 1 + 1 + 6 + 3
  const allyLen = 4 * (config.unitsPerTeam - 1)
  const enemyLen = 5 * config.maxVisibleEnemies
  const k = config.patchHops
  const patchLen = 5 * (1 + 3 * k * (k + 1))
  const summaryLen = config.teamCount + 3
  return selfLen + allyLen + enemyLen + patchLen + summaryLen
}

describe('observation', () => {
  it('produces a fixed-length vector matching the configured sizes', () => {
    const config = makeConfig()
    const origin = 0
    const self = makeUnit(0, 0, origin)
    const state = makeState(1, config, [self, makeUnit(1, 0, origin), makeUnit(2, 0, origin), makeUnit(3, 1, origin)])
    const nodeIndex = buildNodeIndex(state)
    const visibleEnemies = computeVisibleEnemies(state, self)

    const obs = buildObservation(state, self, visibleEnemies, nodeIndex)

    expect(obs.vector).toHaveLength(expectedVectorLength(config))
    expect(obs.vector.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('pads visible-enemy slots with zeros and -1 ids when there are fewer enemies than maxVisibleEnemies', () => {
    const config = makeConfig({ maxVisibleEnemies: 4 })
    const self = makeUnit(0, 0, 0)
    // no enemies at all (single-team state)
    const state = makeState(2, config, [self, makeUnit(1, 0, 0), makeUnit(2, 0, 0)])
    const nodeIndex = buildNodeIndex(state)

    const obs = buildObservation(state, self, [], nodeIndex)

    expect(obs.visibleEnemyIds).toEqual([-1, -1, -1, -1])
  })

  it('reports ally hp/alive correctly and marks a dead ally', () => {
    const config = makeConfig()
    const self = makeUnit(0, 0, 0)
    const deadAlly = { ...makeUnit(1, 0, 0, 40), alive: false }
    const aliveAlly = makeUnit(2, 0, 0, 77)
    const state = makeState(3, config, [self, deadAlly, aliveAlly, makeUnit(3, 1, 0)])
    const nodeIndex = buildNodeIndex(state)

    const obs = buildObservation(state, self, [], nodeIndex)
    // self block is 21 long, then 4 floats per ally slot, sorted by ascending unit id (1 then 2)
    const allyBlock = obs.vector.slice(21, 21 + 8)
    expect(allyBlock[2]).toBeCloseTo(40 / config.unitHP, 10) // deadAlly hp
    expect(allyBlock[3]).toBe(0) // deadAlly alive flag
    expect(allyBlock[6]).toBeCloseTo(77 / config.unitHP, 10) // aliveAlly hp
    expect(allyBlock[7]).toBe(1) // aliveAlly alive flag
  })

  it('fills patch cells outside the generated map with wall+neutral padding', () => {
    // radius 1 map with a patch radius of 3 guarantees most patch cells fall off the map.
    const config = makeConfig({ mapRadius: 1, patchHops: 3 })
    const { nodes } = generateMap(4, config)
    const originIdx = nodes.findIndex((n) => n.q === 0 && n.r === 0)
    const self = makeUnit(0, 0, originIdx)
    const state = makeState(4, config, [
      self,
      makeUnit(1, 0, originIdx),
      makeUnit(2, 0, originIdx),
      makeUnit(3, 1, originIdx),
    ])
    const nodeIndex = buildNodeIndex(state)

    const obs = buildObservation(state, self, [], nodeIndex)
    expect(obs.vector.every((v) => Number.isFinite(v))).toBe(true)
    // Every possible cell within radius 1 must have been generated, so at least SOME patch cells
    // (radius 2-3 ring) must be off-map padding: [elevation=0, wall=1, self=0, enemy=0, neutral=1].
    const patchStart = 21 + 4 * (config.unitsPerTeam - 1) + 5 * config.maxVisibleEnemies
    const patchLen = 5 * (1 + 3 * config.patchHops * (config.patchHops + 1))
    const patch = obs.vector.slice(patchStart, patchStart + patchLen)
    const cells: number[][] = []
    for (let i = 0; i < patch.length; i += 5) cells.push(patch.slice(i, i + 5))
    expect(cells).toContainEqual([0, 1, 0, 0, 1])
  })

  it('encodes direction one-hot and 0 progress when standing on a node, and progress when mid-edge', () => {
    const config = makeConfig()
    const onNodeUnit = makeUnit(0, 0, 0)
    const state = makeState(5, config, [onNodeUnit, makeUnit(1, 0, 0), makeUnit(2, 0, 0), makeUnit(3, 1, 0)])
    const nodeIndex = buildNodeIndex(state)

    const onNodeObs = buildObservation(state, onNodeUnit, [], nodeIndex)
    // self block: [relX,relY,ringRadius,ticksUntilShrink,inRing,relNextX,relNextY,nextRingRadius,
    // elevation,hp,onNode,progress, dir x6, owner x3]
    expect(onNodeObs.vector[10]).toBe(1) // onNode flag
    expect(onNodeObs.vector[11]).toBe(0) // progress
    expect(onNodeObs.vector.slice(12, 18)).toEqual([0, 0, 0, 0, 0, 0]) // no direction while stationary

    const neighborNode = state.neighbors[0][0]
    const midEdgeUnit: UnitState = { ...onNodeUnit, pos: { from: 0, to: neighborNode, progress: 0.4 } }
    const midEdgeObs = buildObservation(state, midEdgeUnit, [], nodeIndex)
    expect(midEdgeObs.vector[10]).toBe(0)
    expect(midEdgeObs.vector[11]).toBeCloseTo(0.4, 10)
    expect(midEdgeObs.vector.slice(12, 18).filter((v) => v === 1)).toHaveLength(1)
  })
})
