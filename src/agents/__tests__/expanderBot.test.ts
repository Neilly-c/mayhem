import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, UnitState } from '../../sim'
import { decideCommands } from '../expanderBot'

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
    ability: 'paintball',
    abilityCooldownRemaining: 0,
    abilityActiveTicksRemaining: 0,
    abilityCommand: { type: 'none' },
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
    config: createConfig({ visionCoreRadius: 100, attackRange: 2, ...overrides }),
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
    projectiles: [],
    nextProjectileId: 0,
    laserBeams: [],
    nextLaserBeamId: 0,
  }
}

describe('expanderBot', () => {
  it('retreats to the nearest safe node when outside the ring, ignoring everything else', () => {
    const nodes = [makeNode(0), makeNode(1), makeNode(2)]
    const self = makeUnit(0, 0, 2)
    const state = makeState(nodes, [self])
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 0.5 // only node 0 counts as safe

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 0 })
  })

  it('attacks the nearest in-range enemy while still heading out to expand', () => {
    const nodes = [makeNode(0, 0), makeNode(1), makeNode(2)] // node 0 is self's home base
    const self = makeUnit(0, 0, 0)
    const enemy = makeUnit(1, 1, 2) // 2 hops away, within attackRange but not blocking node 1
    const state = makeState(nodes, [self, enemy])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.attackTarget).toBe(1)
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 1 }) // node 1 is neutral and nearest
  })

  it('ユーザー要望: skips a nearer neutral node currently occupied by a teammate, heading to the next-nearest free one instead', () => {
    const nodes = [makeNode(0, 0), makeNode(1), makeNode(2)] // node 0 is self's home base
    const self = makeUnit(0, 0, 0)
    const teammate = makeUnit(1, 0, 1) // sitting right on node 1, the otherwise-nearest neutral node
    const state = makeState(nodes, [self, teammate])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 2 })
  })

  it('ユーザー要望: does NOT skip a neutral/enemy node just because an enemy unit is standing there — approaching to contest it is the point', () => {
    const nodes = [makeNode(0, 0), makeNode(1), makeNode(2)] // node 0 is self's home base
    const self = makeUnit(0, 0, 0)
    const enemy = makeUnit(1, 1, 1) // sitting on node 1, the nearest neutral node
    const state = makeState(nodes, [self, enemy])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 1 })
  })

  it('ユーザー要望: keeps holding an in-progress enemy-node capture instead of wandering off to the next candidate', () => {
    // Standing on node 1 (enemy-owned, capture already in progress) with node 2 (neutral) one hop
    // away -- without the "stay if not yet self-owned" check this would abandon the capture and
    // head to node 2 instead every time the bot re-decides.
    const nodes = [makeNode(0, 0), makeNode(1, 1), makeNode(2)]
    const self = makeUnit(0, 0, 1)
    const state = makeState(nodes, [self])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 1 })
  })

  it('moves toward the nearest neutral node over a closer already self-owned one', () => {
    const nodes = [makeNode(0, 0), makeNode(1, 0), makeNode(2, null)]
    const self = makeUnit(0, 0, 0)
    const state = makeState(nodes, [self])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 2 })
  })

  it('idles once every reachable node is already self-owned', () => {
    const nodes = [makeNode(0, 0), makeNode(1, 0)]
    const self = makeUnit(0, 0, 0)
    const state = makeState(nodes, [self])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'idle' })
  })

  it('skips dead or missing units', () => {
    const nodes = [makeNode(0)]
    const dead = { ...makeUnit(0, 0, 0), alive: false }
    const state = makeState(nodes, [dead])

    const decisions = decideCommands(state, [0, 999])
    expect(decisions.size).toBe(0)
  })
})
