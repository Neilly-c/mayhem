import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, UnitState } from '../../sim'
import { pickBestDirection } from '../movementHelpers'

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
