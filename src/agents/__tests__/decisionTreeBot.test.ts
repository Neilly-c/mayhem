import { describe, expect, it } from 'vitest'
import { createConfig, generateMap, hexDist, initRingState } from '../../sim'
import type { GameState, SimConfig, UnitState } from '../../sim'
import { decideCommands } from '../decisionTreeBot'

function makeUnit(id: number, teamId: number, atNode: number, hp = 100, alive = true): UnitState {
  return {
    id,
    teamId,
    pos: { from: atNode, to: atNode, progress: 0 },
    hp,
    alive,
    command: { type: 'idle' },
    attackTarget: null,
    destination: null,
    path: null,
    lastDamagedByTeamId: null,
  }
}

/** wallThreshold:0 -> every generated node passable, giving a real hex disk with true 6-neighbor geometry. */
function makeState(seed: number, overrides?: Partial<SimConfig>): GameState {
  const config = createConfig({
    mapRadius: 4,
    wallThreshold: 0,
    visionRange: 100,
    attackRange: 2,
    ...overrides,
  })
  const { nodes, neighbors } = generateMap(seed, config)
  return {
    seed,
    tick: 0,
    config,
    nodes,
    neighbors,
    teams: [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
    ],
    units: [],
    ring: initRingState(seed, config, nodes),
  }
}

function nodeAt(state: GameState, q: number, r: number): number {
  const idx = state.nodes.findIndex((n) => n.q === q && n.r === r)
  if (idx === -1) throw new Error(`no node at (${q},${r})`)
  return idx
}

describe('decisionTreeBot', () => {
  it('flees away from the nearest visible enemy when HP is below the flee threshold', () => {
    const state = makeState(1)
    const selfNode = nodeAt(state, 0, 0)
    const enemyNode = nodeAt(state, 1, 0)
    state.ring.activeRadius = 100 // large enough that ring never interferes with this test
    state.units = [makeUnit(0, 0, selfNode, 10), makeUnit(1, 1, enemyNode)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.attackTarget).toBeNull()
    expect(decisions.get(0)?.command).toEqual({ type: 'moveDirection', dir: 3 }) // away from (1,0) -> toward (-1,0)
  })

  it('prioritizes returning to the ring over fleeing an enemy when both conditions hold', () => {
    const state = makeState(8)
    const selfNode = nodeAt(state, 2, 0) // world (2,0)
    const enemyNode = nodeAt(state, 3, 0) // world (3,0): would normally trigger flee (low HP)
    state.units = [makeUnit(0, 0, selfNode, 5), makeUnit(1, 1, enemyNode)] // hp fraction 0.05 < fleeHpFraction
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 1.0 // self at distance 2 -> outside the ring

    const decisions = decideCommands(state, [0])
    // Ring-retreat wins: moves toward (0,0), i.e. direction dir 3 (toward (1,0)), not away from the enemy.
    expect(decisions.get(0)?.command).toEqual({ type: 'moveDirection', dir: 3 })
    // Ring-retreat does not suppress the (independent) attack decision.
    expect(decisions.get(0)?.attackTarget).toBe(1)
  })

  it('moves toward the ring center when currently outside the safe zone', () => {
    const state = makeState(2)
    const selfNode = nodeAt(state, 2, 0)
    state.units = [makeUnit(0, 0, selfNode, 100)] // healthy, no enemies at all
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 1.0 // self at world (2,0), distance 2 -> outside

    const decisions = decideCommands(state, [0])
    // Best neighbor toward (0,0) from (2,0) is (1,0), i.e. direction back toward the center.
    expect(decisions.get(0)?.command).toEqual({ type: 'moveDirection', dir: 3 })
  })

  it('holds position and attacks when an enemy is within attack range (stationary damage bonus)', () => {
    const state = makeState(3)
    const selfNode = nodeAt(state, 0, 0)
    const enemyNode = nodeAt(state, 1, 0) // world distance 1.0, within default attackRange 2.0
    state.ring.activeRadius = 100
    state.units = [makeUnit(0, 0, selfNode), makeUnit(1, 1, enemyNode)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: selfNode })
    expect(decisions.get(0)?.attackTarget).toBe(1)
  })

  it('closes the distance toward a visible enemy that is out of attack range', () => {
    const state = makeState(4, { attackRange: 0.5 })
    const selfNode = nodeAt(state, 0, 0)
    const enemyNode = nodeAt(state, 1, 0) // distance 1.0 > attackRange 0.5, but within visionRange
    state.ring.activeRadius = 100
    state.units = [makeUnit(0, 0, selfNode), makeUnit(1, 1, enemyNode)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.attackTarget).toBeNull()
    expect(decisions.get(0)?.command).toEqual({ type: 'moveDirection', dir: 0 }) // toward (1,0)
  })

  it('expands territory toward the nearest unclaimed node, preferring neutral over closer enemy-owned', () => {
    const state = makeState(5)
    const selfNode = nodeAt(state, 0, 0)
    state.nodes[selfNode].owner = 0
    // Block every 1-hop neighbor with enemy ownership, so any neutral node found must be >= 2 hops
    // away — proving neutral is preferred even when it's farther than the available enemy-owned option.
    for (const n of state.neighbors[selfNode]) state.nodes[n].owner = 1
    state.ring.activeRadius = 100
    state.units = [makeUnit(0, 0, selfNode)] // no enemies visible at all

    const decisions = decideCommands(state, [0])
    const command = decisions.get(0)?.command
    expect(command?.type).toBe('moveTo')
    const targetNode = command && command.type === 'moveTo' ? command.node : -1
    expect(state.nodes[targetNode].owner).toBeNull()
    expect(hexDist(state.nodes[selfNode], state.nodes[targetNode])).toBe(2)
  })

  it('falls back to idle when every reachable node is already owned by the unit\'s own team', () => {
    const state = makeState(6)
    const selfNode = nodeAt(state, 0, 0)
    for (const node of state.nodes) node.owner = 0
    state.ring.activeRadius = 100
    state.units = [makeUnit(0, 0, selfNode)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'idle' })
  })

  it('skips dead and unknown units', () => {
    const state = makeState(7)
    const selfNode = nodeAt(state, 0, 0)
    state.units = [makeUnit(0, 0, selfNode, 100, false)]

    const decisions = decideCommands(state, [0, 999])
    expect(decisions.size).toBe(0)
  })
})
