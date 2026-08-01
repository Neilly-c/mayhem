import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, UnitState } from '../../sim'
import { decideCommands } from '../raiderBot'

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

describe('raiderBot', () => {
  it('retreats to the nearest safe node when outside the ring, ignoring everything else', () => {
    const nodes = [makeNode(0), makeNode(1), makeNode(2)]
    const self = makeUnit(0, 0, 2)
    const state = makeState(nodes, [self])
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 0.5 // only node 0 counts as safe

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 0 })
  })

  it('engages: holds position (stationary attack bonus) and attacks when an enemy is in range', () => {
    const nodes = [makeNode(0), makeNode(1)]
    const self = makeUnit(0, 0, 0)
    const enemy = makeUnit(1, 1, 1)
    const state = makeState(nodes, [self, enemy])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 0 })
    expect(decisions.get(0)?.attackTarget).toBe(1)
  })

  it('chases a visible enemy that is out of range instead of holding or expanding', () => {
    // self stands at node 1 (neighbors at x=0 and x=2); the enemy sits far out at x=90 -- visible
    // (visionCoreRadius 100) but well outside attackRange, so the only sensible move is toward it.
    const nodes = [makeNode(0), makeNode(1), makeNode(2), makeNode(90)]
    const self = makeUnit(0, 0, 1)
    const farEnemy = makeUnit(1, 1, 3)
    const state = makeState(nodes, [self, farEnemy])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveDirection', dir: 0 }) // toward node 2 (x=2), closer to the enemy
    expect(decisions.get(0)?.attackTarget).toBeNull()
  })

  it('expands to the nearest unclaimed node when no enemy is visible', () => {
    const nodes = [makeNode(0, 0), makeNode(1)]
    const self = makeUnit(0, 0, 0)
    const state = makeState(nodes, [self])

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: 1 })
  })

  it('idles once every reachable node is already self-owned and no enemy is visible', () => {
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
