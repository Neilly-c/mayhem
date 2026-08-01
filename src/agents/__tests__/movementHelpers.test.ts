import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, UnitState } from '../../sim'
import { findNearestOwnNode, findNearestSafeNode, findNearestUnclaimedNode, pickBestDirection } from '../movementHelpers'

function makeNode(q: number): NodeState {
  return { q, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }
}

function makeUnit(atNode: number, pos?: UnitState['pos']): UnitState {
  return {
    id: 0,
    teamId: 0,
    pos: pos ?? { from: atNode, to: atNode, progress: 0 },
    hp: 100,
    alive: true,
    command: { type: 'idle' },
    attackTarget: null,
    destination: null,
    path: null,
    lastDamagedByTeamId: null,
    ability: 'paintball',
    abilityCooldownRemaining: 0,
    abilityActiveTicksRemaining: 0,
    abilityCommand: { type: 'none' },
  }
}

/** Line of nodes q=0..2 (middle node has neighbors on both sides). */
function makeState(): GameState {
  return {
    seed: 1,
    tick: 0,
    config: createConfig(),
    nodes: [makeNode(0), makeNode(1), makeNode(2)],
    neighbors: [[1], [0, 2], [1]],
    teams: [{ id: 0, alive: true, eliminatedAtTick: null, killCount: 0 }],
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
    projectiles: [],
    nextProjectileId: 0,
    laserBeams: [],
    nextLaserBeamId: 0,
  }
}

describe('pickBestDirection', () => {
  it('picks the neighbor that maximizes the given score', () => {
    const state = makeState()
    const unit = makeUnit(1) // middle node, neighbors at x=0 and x=2
    const command = pickBestDirection(state, unit, (candidate) => candidate.x) // prefer larger x
    expect(command).toEqual({ type: 'moveDirection', dir: 0 }) // toward node 2 (x=2)
  })

  it('picks the opposite neighbor when the score favors the other direction', () => {
    const state = makeState()
    const unit = makeUnit(1)
    const command = pickBestDirection(state, unit, (candidate) => -candidate.x) // prefer smaller x
    expect(command).toEqual({ type: 'moveDirection', dir: 3 }) // toward node 0 (x=0)
  })

  it('returns an inert moveDirection while mid-edge, without touching destination-triggering idle', () => {
    const state = makeState()
    const unit = makeUnit(0, { from: 0, to: 1, progress: 0.5 })
    const command = pickBestDirection(state, unit, (candidate) => candidate.x)
    expect(command).toEqual({ type: 'moveDirection', dir: 0 })
  })

  it('falls back to idle when no neighbor improves on the score (isolated node)', () => {
    const state = makeState()
    state.neighbors = [[], [], []] // no edges at all
    const unit = makeUnit(1)
    const command = pickBestDirection(state, unit, (candidate) => candidate.x)
    expect(command).toEqual({ type: 'idle' })
  })
})

describe('findNearestSafeNode', () => {
  it("returns the unit's own node when already inside the ring", () => {
    const state = makeState()
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 100
    const unit = makeUnit(1)
    expect(findNearestSafeNode(state, unit)).toBe(1)
  })

  it('returns null when no reachable node is within the safe radius', () => {
    const state = makeState()
    state.ring.centerWorld = { x: 1000, y: 1000 }
    state.ring.activeRadius = 0.001
    const unit = makeUnit(1)
    expect(findNearestSafeNode(state, unit)).toBeNull()
  })

  it('ユーザー要望: finds the node that is actually reachable via the safe route, not the straight-line-closest one that turns out to be a dead end', () => {
    // All nodes on r=0 so world position = (q, 0), keeping the geometry easy to reason about.
    // 0(start, x=0) branches to 1 (x=6, closer in a straight line to the ring center at x=10, but
    // a dead end) and 2 (x=3, farther in a straight line, but the only route that eventually
    // reaches safety at 4 via 3). Greedy nearest-first hill-climbing (the old
    // pickBestDirection-based approach) would commit to 1 and get stuck there; BFS naturally still
    // finds the real route via 2 -> 3 -> 4.
    const nodes: NodeState[] = [
      { q: 0, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }, // world (0,0)
      { q: 6, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }, // world (6,0), dead end
      { q: 3, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }, // detour entry
      { q: 8, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }, // detour continues
      { q: 10, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }, // world (10,0): safe
    ]
    const neighbors = [[1, 2], [0], [0, 3], [2, 4], [3]]
    const state = makeState()
    state.nodes = nodes
    state.neighbors = neighbors
    state.ring.centerWorld = { x: 10, y: 0 }
    state.ring.activeRadius = 0.5 // only node 4 (exactly at the center) qualifies as safe
    const unit = makeUnit(0)

    expect(findNearestSafeNode(state, unit)).toBe(4)
  })
})

describe('findNearestUnclaimedNode', () => {
  it('prefers the nearest neutral node over a closer enemy-owned one', () => {
    const state = makeState()
    state.nodes[0].owner = 0
    state.nodes[2].owner = 1 // node 2 is directly adjacent (1 hop) but enemy-owned
    // node 1 (self) -> node 2 is 1 hop (enemy-owned), node 0 is also 1 hop but self-owned already.
    // Extend the line so a neutral node exists 2 hops away via node 2.
    state.nodes = [...state.nodes, { q: 3, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }]
    state.neighbors = [[1], [0, 2], [1, 3], [2]]
    const unit = makeUnit(1)
    expect(findNearestUnclaimedNode(state, unit)).toBe(3) // neutral, even though farther than node 2
  })

  it('falls back to the nearest enemy-owned node when no neutral node is reachable', () => {
    const state = makeState()
    state.nodes[0].owner = 0
    state.nodes[2].owner = 1
    const unit = makeUnit(1)
    expect(findNearestUnclaimedNode(state, unit)).toBe(2)
  })

  it('returns null when every reachable node is already self-owned', () => {
    const state = makeState()
    state.nodes[0].owner = 0
    state.nodes[1].owner = 0
    state.nodes[2].owner = 0
    const unit = makeUnit(1)
    expect(findNearestUnclaimedNode(state, unit)).toBeNull()
  })

  it('ユーザー要望: skips a neutral node currently occupied by another unit, in favor of the next-nearest free one', () => {
    const state = makeState()
    const unit = makeUnit(1)
    const occupant = { ...makeUnit(2), id: 1 } // sitting on node 2, otherwise the nearest neutral node
    state.units = [occupant]
    expect(findNearestUnclaimedNode(state, unit)).toBe(0) // node 0 is the other 1-hop neutral neighbor
  })

  it('does not treat its own current position as occupied', () => {
    const state = makeState()
    const unit = makeUnit(1)
    state.units = [unit]
    expect(findNearestUnclaimedNode(state, unit)).not.toBeNull()
  })
})

describe('findNearestOwnNode', () => {
  it("returns the unit's own node when already standing on self-owned territory", () => {
    const state = makeState()
    state.nodes[1].owner = 0
    const unit = makeUnit(1)
    expect(findNearestOwnNode(state, unit)).toBe(1)
  })

  it('BFSes to the nearest self-owned node otherwise', () => {
    const state = makeState()
    state.nodes[2].owner = 0
    const unit = makeUnit(1)
    expect(findNearestOwnNode(state, unit)).toBe(2)
  })

  it('returns null when the team owns nothing reachable', () => {
    const state = makeState()
    const unit = makeUnit(1)
    expect(findNearestOwnNode(state, unit)).toBeNull()
  })

  it('ユーザー要望: skips a self-owned node currently occupied by another unit, in favor of the next-nearest free one', () => {
    const state = makeState()
    state.nodes[0].owner = 0
    state.nodes[2].owner = 0
    const unit = makeUnit(1)
    const occupant = { ...makeUnit(0), id: 1 } // camping on node 0, otherwise the nearest self-owned node
    state.units = [occupant]
    expect(findNearestOwnNode(state, unit)).toBe(2)
  })
})
