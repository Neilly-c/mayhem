import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, UnitState } from '../../sim'
import { decideCommands } from '../guardianBot'

function makeNode(q: number, owner: number | null = null): NodeState {
  return { q, r: 0, elevation: 0.5, passable: true, owner, captureProgress: null }
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

/** Line of nodes q=0..N-1 (world x=q), each linked to its immediate neighbors only. */
function makeState(nodes: NodeState[], units: UnitState[], overrides?: Partial<GameState['config']>): GameState {
  const neighbors = nodes.map((_, i) => {
    const n: number[] = []
    if (i > 0) n.push(i - 1)
    if (i < nodes.length - 1) n.push(i + 1)
    return n
  })
  return {
    seed: 1,
    tick: 0,
    config: createConfig({ visionRange: 100, attackRange: 2, ...overrides }),
    nodes,
    neighbors,
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

describe('guardianBot', () => {
  it('retreats to the nearest safe node when outside the ring, even overriding a healing need', () => {
    const nodes = [makeNode(0), makeNode(1), makeNode(2)]
    const self = makeUnit(0, 0, 2, 10) // low hp too, to prove ring retreat wins over the heal branch
    const state = makeState(nodes, [self])
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 0.5 // only node 0 counts as safe

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 0 })
  })

  it('heals: heads toward the nearest own node when hp is low and one exists', () => {
    const nodes = [makeNode(0), makeNode(1), makeNode(2, 0)]
    const self = makeUnit(0, 0, 0, 10) // 10/100 hp, below the default 0.5 threshold
    const state = makeState(nodes, [self])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 2 })
  })

  it('heals: idles once already standing on own territory', () => {
    const nodes = [makeNode(0, 0)]
    const self = makeUnit(0, 0, 0, 10)
    const state = makeState(nodes, [self])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'idle' })
  })

  it('heals: falls back to expanding toward the nearest unclaimed node when nothing is owned yet', () => {
    const nodes = [makeNode(0), makeNode(1)]
    const self = makeUnit(0, 0, 0, 10)
    const state = makeState(nodes, [self])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 1 })
  })

  it('defends: rushes to the own node under threat instead of expanding', () => {
    // 0(self-owned, far) - 1 - 2(self, standing here) - 3(enemy) - 4(self-owned, far).
    // attackRange 1.5 keeps only node 4 (distance 1 from the enemy at node 3) threatened;
    // node 0 (distance 3 from the enemy) stays safe, so the choice between the two is unambiguous.
    const nodes = [makeNode(0, 0), makeNode(1), makeNode(2), makeNode(3), makeNode(4, 0)]
    const self = makeUnit(0, 0, 2)
    const enemy = makeUnit(1, 1, 3)
    const state = makeState(nodes, [self, enemy], { attackRange: 1.5 })

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 4 })
  })

  it('ユーザー要望: defends the next-nearest threatened own node when the nearest one is already occupied by a teammate', () => {
    const nodes = [makeNode(0, 0), makeNode(1), makeNode(2), makeNode(3), makeNode(4), makeNode(5), makeNode(6, 0)]
    const self = makeUnit(0, 0, 2) // distance 2 from node 0, distance 4 from node 6
    const enemy = makeUnit(1, 1, 3)
    const teammate = makeUnit(2, 0, 0) // already camping on node 0, the nearer threatened node
    const state = makeState(nodes, [self, enemy, teammate], { attackRange: 10 })

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 6 })
  })

  it('expands to the nearest unclaimed node when at full hp and nothing is threatened', () => {
    const nodes = [makeNode(0, 0), makeNode(1)]
    const self = makeUnit(0, 0, 0)
    const state = makeState(nodes, [self])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 1 })
  })

  it('always attacks the nearest in-range enemy regardless of the movement branch', () => {
    const nodes = [makeNode(0), makeNode(1)]
    const self = makeUnit(0, 0, 0)
    const enemy = makeUnit(1, 1, 1)
    const state = makeState(nodes, [self, enemy])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.attackTarget).toBe(1)
  })

  it('skips dead or missing units', () => {
    const nodes = [makeNode(0)]
    const dead = { ...makeUnit(0, 0, 0), alive: false }
    const state = makeState(nodes, [dead])

    const decisions = decideCommands(state, [0, 999])
    expect(decisions.size).toBe(0)
  })
})
