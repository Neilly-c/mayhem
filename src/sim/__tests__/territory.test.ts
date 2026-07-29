import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import type { GameState, NodeState, UnitState } from '../types'
import { resolveTerritory } from '../territory'

function makeNode(): NodeState {
  return { q: 0, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }
}

function makeUnit(id: number, teamId: number, atNode: number): UnitState {
  return {
    id,
    teamId,
    pos: { from: atNode, to: atNode, progress: 0 },
    hp: 100,
    alive: true,
    command: { type: 'idle' },
    attackTarget: null,
    destination: null,
    path: null,
    lastDamagedByTeamId: null,
  }
}

function makeState(overrides?: Partial<GameState['config']>): GameState {
  const config = createConfig({ captureTicks: 3, ...overrides })
  return {
    seed: 1,
    tick: 0,
    config,
    nodes: [makeNode()],
    neighbors: [[]],
    teams: [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
    ],
    units: [],
    ring: {
      stage: 0,
      phase: 'warn',
      phaseTicks: 0,
      centerWorld: { x: 0, y: 0 },
      activeRadius: 100,
      shrinkStartCenter: { x: 0, y: 0 },
      nextCenter: 0,
      nextRadius: 100,
    },
  }
}

describe('territory', () => {
  it('captures a neutral node instantly when a single team stands on it, and reports the capture event', () => {
    const state = makeState()
    state.units = [makeUnit(0, 0, 0)]
    const captures = resolveTerritory(state, [])
    expect(state.nodes[0].owner).toBe(0)
    expect(captures).toEqual([{ node: 0, teamId: 0 }])
  })

  it('leaves a neutral node uncaptured when two teams arrive on it simultaneously, reporting no captures', () => {
    const state = makeState()
    state.units = [makeUnit(0, 0, 0), makeUnit(1, 1, 0)]
    const captures = resolveTerritory(state, [])
    expect(state.nodes[0].owner).toBeNull()
    expect(captures).toEqual([])
  })

  it('does not count a unit still mid-edge (never arrived this tick) as present for capture', () => {
    const state = makeState()
    state.nodes.push(makeNode())
    state.neighbors = [[1], [0]]
    state.units = [makeUnit(0, 0, 0)]
    state.units[0].pos = { from: 0, to: 1, progress: 0.5 } // mid-edge between node 0 and node 1

    resolveTerritory(state, [])

    expect(state.nodes[0].owner).toBeNull()
    expect(state.nodes[1].owner).toBeNull()
  })

  it('instantly captures a neutral node that a unit merely passed through this tick (§6)', () => {
    const state = makeState()
    state.units = [] // the unit already continued on to some other node; nobody is stationary here
    const captures = resolveTerritory(state, [{ teamId: 0, node: 0 }])
    expect(state.nodes[0].owner).toBe(0)
    expect(captures).toEqual([{ node: 0, teamId: 0 }])
  })

  it('does not capture via pass-through when two different teams passed through the same neutral node this tick', () => {
    const state = makeState()
    state.units = []
    const captures = resolveTerritory(state, [
      { teamId: 0, node: 0 },
      { teamId: 1, node: 0 },
    ])
    expect(state.nodes[0].owner).toBeNull()
    expect(captures).toEqual([])
  })

  it('does not let a pass-through alone capture an enemy-owned node (only sustained presence can)', () => {
    const state = makeState()
    state.nodes[0].owner = 1
    state.units = []
    const captures = resolveTerritory(state, [{ teamId: 0, node: 0 }])
    expect(state.nodes[0].owner).toBe(1)
    expect(state.nodes[0].captureProgress).toBeNull()
    expect(captures).toEqual([])
  })

  it('accrues captureProgress against an enemy node and captures at captureTicks', () => {
    const state = makeState({ captureTicks: 3 })
    state.nodes[0].owner = 1
    state.units = [makeUnit(0, 0, 0)]

    resolveTerritory(state, [])
    expect(state.nodes[0].captureProgress).toEqual({ teamId: 0, ticks: 1 })
    expect(state.nodes[0].owner).toBe(1)

    resolveTerritory(state, [])
    expect(state.nodes[0].captureProgress).toEqual({ teamId: 0, ticks: 2 })

    const finalCaptures = resolveTerritory(state, [])
    expect(state.nodes[0].owner).toBe(0)
    expect(state.nodes[0].captureProgress).toBeNull()
    expect(finalCaptures).toEqual([{ node: 0, teamId: 0 }])
  })

  it('resets captureProgress when the attacking team leaves the node', () => {
    const state = makeState()
    state.nodes[0].owner = 1
    state.nodes[0].captureProgress = { teamId: 0, ticks: 2 }
    state.units = [] // nobody present this tick
    resolveTerritory(state, [])
    expect(state.nodes[0].captureProgress).toBeNull()
  })

  it('does not change owner when the owning team is alone on its own node', () => {
    const state = makeState()
    state.nodes[0].owner = 1
    state.units = [makeUnit(0, 1, 0)]
    resolveTerritory(state, [])
    expect(state.nodes[0].owner).toBe(1)
    expect(state.nodes[0].captureProgress).toBeNull()
  })

  it('freezes captureProgress by default when the node is contested', () => {
    const state = makeState({ contestedCaptureBehavior: 'freeze' })
    state.nodes[0].owner = 1
    state.nodes[0].captureProgress = { teamId: 0, ticks: 2 }
    state.units = [makeUnit(0, 0, 0), makeUnit(1, 1, 0)] // attacker + defender both present
    resolveTerritory(state, [])
    expect(state.nodes[0].captureProgress).toEqual({ teamId: 0, ticks: 2 })
    expect(state.nodes[0].owner).toBe(1)
  })

  it('resets captureProgress when contested and contestedCaptureBehavior is "reset"', () => {
    const state = makeState({ contestedCaptureBehavior: 'reset' })
    state.nodes[0].owner = 1
    state.nodes[0].captureProgress = { teamId: 0, ticks: 2 }
    state.units = [makeUnit(0, 0, 0), makeUnit(1, 1, 0)]
    resolveTerritory(state, [])
    expect(state.nodes[0].captureProgress).toBeNull()
  })
})
