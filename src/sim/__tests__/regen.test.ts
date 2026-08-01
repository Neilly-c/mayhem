import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import type { GameState, NodeState, UnitState } from '../types'
import { applyRegen } from '../regen'

function makeNode(owner: number | null = null): NodeState {
  return { q: 0, r: 0, elevation: 0.5, passable: true, owner, captureProgress: null }
}

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
    ability: 'paintball',
    abilityCooldownRemaining: 0,
    abilityActiveTicksRemaining: 0,
    abilityCommand: { type: 'none' },
  }
}

function makeState(units: UnitState[], node: NodeState, overrides?: Partial<GameState['config']>): GameState {
  const config = createConfig({ territoryRegenRate: 0.05, unitHP: 100, ...overrides })
  return {
    seed: 1,
    tick: 0,
    config,
    nodes: [node],
    neighbors: [[]],
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

describe('applyRegen', () => {
  it('heals a stationary unit standing on its own territory', () => {
    const state = makeState([makeUnit(0, 0, 0, 50)], makeNode(0))
    const events = applyRegen(state)
    expect(state.units[0].hp).toBeCloseTo(50.05, 10)
    expect(events).toEqual([{ unitId: 0, amount: state.config.territoryRegenRate }])
  })

  it('does not heal a unit that is mid-edge (moving)', () => {
    const state = makeState([makeUnit(0, 0, 0, 50)], makeNode(0))
    state.nodes.push(makeNode(0))
    state.units[0].pos = { from: 0, to: 1, progress: 0.5 } // genuinely mid-edge
    const events = applyRegen(state)
    expect(state.units[0].hp).toBe(50)
    expect(events).toEqual([])
  })

  it('does not heal on a neutral or enemy-owned node', () => {
    const neutralState = makeState([makeUnit(0, 0, 0, 50)], makeNode(null))
    expect(applyRegen(neutralState)).toEqual([])
    expect(neutralState.units[0].hp).toBe(50)

    const enemyState = makeState([makeUnit(0, 0, 0, 50)], makeNode(1))
    expect(applyRegen(enemyState)).toEqual([])
    expect(enemyState.units[0].hp).toBe(50)
  })

  it('does not heal dead units', () => {
    const state = makeState([makeUnit(0, 0, 0, 50, false)], makeNode(0))
    expect(applyRegen(state)).toEqual([])
  })

  it('caps healing at unitHP and does not overheal', () => {
    const state = makeState([makeUnit(0, 0, 0, 99.98)], makeNode(0), { territoryRegenRate: 0.05 })
    const events = applyRegen(state)
    expect(state.units[0].hp).toBe(100)
    expect(events).toHaveLength(1)
    expect(events[0].unitId).toBe(0)
    expect(events[0].amount).toBeCloseTo(0.02, 10)

    // Already full: no further event.
    const events2 = applyRegen(state)
    expect(events2).toEqual([])
  })

  it('does nothing when territoryRegenRate is 0', () => {
    const state = makeState([makeUnit(0, 0, 0, 50)], makeNode(0), { territoryRegenRate: 0 })
    expect(applyRegen(state)).toEqual([])
    expect(state.units[0].hp).toBe(50)
  })
})
