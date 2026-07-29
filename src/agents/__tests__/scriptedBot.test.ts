import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, UnitState } from '../../sim'
import { decideCommands } from '../scriptedBot'

function makeNode(q: number): NodeState {
  return { q, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }
}

function makeUnit(id: number, teamId: number, atNode: number, alive = true): UnitState {
  return {
    id,
    teamId,
    pos: { from: atNode, to: atNode, progress: 0 },
    hp: 100,
    alive,
    command: { type: 'idle' },
    attackTarget: null,
    destination: null,
    path: null,
    lastDamagedByTeamId: null,
  }
}

/** Line of nodes q=0..4 (world x = q), so distance from node0 is just the target's q. */
function makeState(units: UnitState[], overrides?: Partial<GameState['config']>): GameState {
  const config = createConfig({ visionRange: 100, attackRange: 2, ...overrides })
  const nodes = [makeNode(0), makeNode(1), makeNode(2), makeNode(3), makeNode(4)]
  return {
    seed: 1,
    tick: 0,
    config,
    nodes,
    neighbors: [[1], [0, 2], [1, 3], [2, 4], [3]],
    teams: [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
    ],
    units,
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

describe('decideCommands', () => {
  it('issues idle movement while inside the safe ring', () => {
    const self = makeUnit(0, 0, 0)
    const state = makeState([self])
    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'idle' })
  })

  it('moves toward the ring center when outside the safe zone, overriding the default idle movement', () => {
    const self = makeUnit(0, 0, 4) // world x=4
    const state = makeState([self])
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 1.0 // self at distance 4 -> outside

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveDirection', dir: 3 }) // toward node 3, i.e. x=3
  })

  it('keeps attacking a nearby enemy while retreating toward the ring', () => {
    const self = makeUnit(0, 0, 4)
    const enemy = makeUnit(1, 1, 3) // world distance 1.0, within default attackRange 2
    const state = makeState([self, enemy])
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 1.0

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveDirection', dir: 3 })
    expect(decisions.get(0)?.attackTarget).toBe(1)
  })

  it('targets the nearest in-range enemy when multiple are visible', () => {
    const self = makeUnit(0, 0, 0)
    const near = makeUnit(1, 1, 1) // dist 1, in range
    const far = makeUnit(2, 1, 3) // dist 3, out of range (attackRange=2)
    const state = makeState([self, near, far])

    const decisions = decideCommands(state, [0])

    expect(decisions.get(0)?.attackTarget).toBe(near.id)
  })

  it('does not attack when no visible enemy is within range', () => {
    const self = makeUnit(0, 0, 0)
    const far = makeUnit(1, 1, 4) // dist 4, out of range
    const state = makeState([self, far])

    const decisions = decideCommands(state, [0])

    expect(decisions.get(0)?.attackTarget).toBeNull()
  })

  it('ignores dead enemies and never decides for a dead unit', () => {
    const self = makeUnit(0, 0, 0)
    const deadEnemy = makeUnit(1, 1, 1, false)
    const deadSelf = makeUnit(2, 0, 0, false)
    const state = makeState([self, deadEnemy, deadSelf])

    const decisions = decideCommands(state, [0, 2])

    expect(decisions.get(0)?.attackTarget).toBeNull()
    expect(decisions.has(2)).toBe(false)
  })
})
