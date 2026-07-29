import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import type { GameState, NodeState, UnitState } from '../types'
import { applyCombatIntent, computeCombatIntents } from '../combat'

function makeNode(q: number, elevation = 0.5): NodeState {
  return { q, r: 0, elevation, passable: true, owner: null, captureProgress: null }
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

/** 4 nodes in a line (q=0..3, r=0), unit 0 (team 0) at node 0, unit 1 (team 1) at node 1. */
function makeCombatState(overrides?: Partial<GameState['config']>): GameState {
  const config = createConfig({
    visionRange: 6.0,
    attackRange: 2.0,
    baseDamage: 1.0,
    // Neutralized so tests below can isolate high-ground/territory/etc. without also having to
    // account for the stationary-attacker omnidirectional bonus; that mechanic gets its own tests.
    stationaryAttackDamageCoef: 1,
    ...overrides,
  })
  return {
    seed: 1,
    tick: 0,
    config,
    nodes: [makeNode(0), makeNode(1), makeNode(2), makeNode(3)],
    neighbors: [[1], [0, 2], [1, 3], [2]],
    teams: [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
    ],
    units: [makeUnit(0, 0, 0), makeUnit(1, 1, 1)],
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

describe('combat', () => {
  it('deals baseDamage with no modifiers at equal elevation and no territory', () => {
    const state = makeCombatState()
    state.units[0].attackTarget = 1
    const intents = computeCombatIntents(state, state.units[0])
    expect(intents).toEqual([{ attackerId: 0, targetId: 1, damage: 1.0 }])
  })

  it('does not fire on a dead target', () => {
    const state = makeCombatState()
    state.units[0].attackTarget = 1
    state.units[1].alive = false
    expect(computeCombatIntents(state, state.units[0])).toEqual([])
  })

  it('does not fire on a same-team target', () => {
    const state = makeCombatState()
    state.units[1].teamId = 0
    state.units[0].attackTarget = 1
    expect(computeCombatIntents(state, state.units[0])).toEqual([])
  })

  it('does not fire when out of attack range', () => {
    const state = makeCombatState({ attackRange: 0.5 })
    state.units[0].attackTarget = 1 // world distance 1.0 > attackRange 0.5
    expect(computeCombatIntents(state, state.units[0])).toEqual([])
  })

  it('does not fire when out of vision range even if in attack range', () => {
    const state = makeCombatState({ visionRange: 0.5, attackRange: 5.0 })
    state.units[0].attackTarget = 1 // distance 1.0 > visionRange 0.5
    expect(computeCombatIntents(state, state.units[0])).toEqual([])
  })

  it('boosts damage with high ground and clamps at coefMax', () => {
    const state = makeCombatState({ highGroundK: 1.0, highGroundCoefMax: 1.5 })
    state.nodes[0].elevation = 1.0
    state.nodes[1].elevation = 0.0 // diff=1.0 -> raw coef = 1 + 1*1 = 2.0, clamped to 1.5
    state.units[0].attackTarget = 1
    const intents = computeCombatIntents(state, state.units[0])
    expect(intents[0]?.damage).toBeCloseTo(1.5, 10)
  })

  it('reduces damage on low ground and clamps at coefMin', () => {
    const state = makeCombatState({ highGroundK: 1.0, highGroundCoefMin: 0.7 })
    state.nodes[0].elevation = 0.0
    state.nodes[1].elevation = 1.0 // diff=-1.0 -> raw coef = 0.0, clamped to 0.7
    state.units[0].attackTarget = 1
    const intents = computeCombatIntents(state, state.units[0])
    expect(intents[0]?.damage).toBeCloseTo(0.7, 10)
  })

  it('applies the territory attack bonus only when the attacker stands on its own owned node', () => {
    const state = makeCombatState({ territoryAtkBonus: 0.1 })
    state.nodes[0].owner = 0
    state.units[0].attackTarget = 1
    const onOwnNode = computeCombatIntents(state, state.units[0])
    expect(onOwnNode[0]?.damage).toBeCloseTo(1.1, 10)

    // Mid-edge: no territory bonus even though standing "on" an owned node conceptually.
    state.units[0].pos = { from: 0, to: 1, progress: 0.1 }
    const midEdge = computeCombatIntents(state, state.units[0])
    expect(midEdge[0]?.damage).toBeCloseTo(1.0, 10)
  })

  it('applyCombatIntent subtracts hp without touching alive, even when it goes negative', () => {
    const state = makeCombatState()
    applyCombatIntent(state, { attackerId: 0, targetId: 1, damage: 250 })
    expect(state.units[1].hp).toBe(100 - 250)
    expect(state.units[1].alive).toBe(true)
  })

  it('applyCombatIntent records the attacker\'s team as the target\'s most recent damage source', () => {
    const state = makeCombatState()
    applyCombatIntent(state, { attackerId: 0, targetId: 1, damage: 10 })
    expect(state.units[1].lastDamagedByTeamId).toBe(0)
  })

  it('applyCombatIntent overwrites lastDamagedByTeamId when a later intent lands from a different attacking team', () => {
    const state = makeCombatState()
    state.units.push(makeUnit(2, 2, 2)) // a third team's attacker
    applyCombatIntent(state, { attackerId: 0, targetId: 1, damage: 10 }) // team 0 hits unit 1 first
    expect(state.units[1].lastDamagedByTeamId).toBe(0)
    applyCombatIntent(state, { attackerId: 2, targetId: 1, damage: 5 }) // team 2 hits unit 1 next
    expect(state.units[1].lastDamagedByTeamId).toBe(2)
  })

  describe('directional facing', () => {
    it('applies the stationary omnidirectional bonus regardless of target direction', () => {
      const state = makeCombatState({ stationaryAttackDamageCoef: 1.5 })
      state.units[0].attackTarget = 1 // unit0 stationary at node0, target at node1 (q=1)
      const intents = computeCombatIntents(state, state.units[0])
      expect(intents[0]?.damage).toBeCloseTo(1.5, 10)
    })

    it('deals normal damage when the target is ahead of the attacker\'s direction of travel', () => {
      const state = makeCombatState({ backAttackDamageCoef: 0.5, attackRange: 1.0 })
      state.units[0].pos = { from: 0, to: 1, progress: 0.5 } // moving +x, world pos (0.5, 0)
      state.units[0].attackTarget = 1 // target at node1 (x=1), ahead in the direction of travel
      const intents = computeCombatIntents(state, state.units[0])
      expect(intents[0]?.damage).toBeCloseTo(1.0, 10)
    })

    it('applies backAttackDamageCoef when the target is behind the attacker\'s direction of travel', () => {
      const state = makeCombatState({ backAttackDamageCoef: 0.5, attackRange: 2.0 })
      state.units[0].pos = { from: 1, to: 2, progress: 0.5 } // moving +x, world pos (1.5, 0)
      state.units[0].attackTarget = 1 // unit1 relocated below to node0 (x=0), behind the attacker
      state.units[1].pos = { from: 0, to: 0, progress: 0 }
      const intents = computeCombatIntents(state, state.units[0])
      expect(intents[0]?.damage).toBeCloseTo(0.5, 10)
    })

    it('treats a target exactly perpendicular to the facing direction as "in front" (dot=0 boundary)', () => {
      const state = makeCombatState({ backAttackDamageCoef: 0.5, attackRange: 2.0 })
      // world(q=-1, r=2) = (-1 + 2*0.5, 2*sqrt3/2) = (0, sqrt3) — same x as node0, so it's exactly
      // perpendicular to the +x facing direction of a unit moving node0 -> node1.
      state.nodes.push({ q: -1, r: 2, elevation: 0.5, passable: true, owner: null, captureProgress: null })
      state.units[0].pos = { from: 0, to: 1, progress: 0 } // mid-edge (facing +x), still exactly at node0's position
      state.units[1].pos = { from: 4, to: 4, progress: 0 } // node index 4 = (q:-1, r:2), perpendicular
      state.units[0].attackTarget = 1
      const intents = computeCombatIntents(state, state.units[0])
      expect(intents[0]?.damage).toBeCloseTo(1.0, 10)
    })
  })

  describe('chain damage', () => {
    it('applies chainDamageCoef of the main hit to enemies clustered near the target, sparing the attacker\'s own team and anyone outside the radius', () => {
      const state = makeCombatState({ chainDamageRadius: 1.5, chainDamageCoef: 0.5 })
      state.units.push(
        makeUnit(2, 1, 2), // team1 @ node2: world dist 1.0 from target (node1) -> within radius
        makeUnit(3, 1, 3), // team1 @ node3: world dist 2.0 from target -> outside radius
        makeUnit(4, 0, 2), // team0 (attacker's own team), same spot as the in-radius enemy -> excluded
      )
      state.units[0].attackTarget = 1

      const intents = computeCombatIntents(state, state.units[0])
      expect(intents).toEqual([
        { attackerId: 0, targetId: 1, damage: 1.0 },
        { attackerId: 0, targetId: 2, damage: 0.5 },
      ])
    })

    it('never chain-damages the attacker itself, even when within radius of the target', () => {
      const state = makeCombatState({ chainDamageRadius: 5, chainDamageCoef: 0.5 })
      state.units[0].attackTarget = 1 // attacker is world dist 1.0 from the target, well within radius 5
      const intents = computeCombatIntents(state, state.units[0])
      expect(intents.some((i) => i.targetId === 0)).toBe(false)
    })

    it('does not double-count the main target as its own chain-damage victim', () => {
      const state = makeCombatState({ chainDamageRadius: 5, chainDamageCoef: 0.5 })
      state.units[0].attackTarget = 1
      const intents = computeCombatIntents(state, state.units[0])
      expect(intents.filter((i) => i.targetId === 1)).toHaveLength(1)
    })

    it('skips dead units when looking for chain-damage victims', () => {
      const state = makeCombatState({ chainDamageRadius: 1.5, chainDamageCoef: 0.5 })
      state.units.push({ ...makeUnit(2, 1, 2), alive: false })
      state.units[0].attackTarget = 1

      const intents = computeCombatIntents(state, state.units[0])
      expect(intents).toEqual([{ attackerId: 0, targetId: 1, damage: 1.0 }])
    })

    it('disables chain damage entirely when chainDamageRadius is 0', () => {
      const state = makeCombatState({ chainDamageRadius: 0, chainDamageCoef: 0.5 })
      state.units.push(makeUnit(2, 1, 2)) // would otherwise be within any reasonable radius
      state.units[0].attackTarget = 1

      const intents = computeCombatIntents(state, state.units[0])
      expect(intents).toEqual([{ attackerId: 0, targetId: 1, damage: 1.0 }])
    })

    it('disables chain damage entirely when chainDamageCoef is 0', () => {
      const state = makeCombatState({ chainDamageRadius: 5, chainDamageCoef: 0 })
      state.units.push(makeUnit(2, 1, 2))
      state.units[0].attackTarget = 1

      const intents = computeCombatIntents(state, state.units[0])
      expect(intents).toEqual([{ attackerId: 0, targetId: 1, damage: 1.0 }])
    })
  })
})
