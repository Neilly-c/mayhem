import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, TeamState, TickEvents, UnitState } from '../../sim'
import { createRewardConfig } from '../rewardConfig'
import { applyTerritoryTerminalBonus, applyTickRewards } from '../rewards'

function makeUnit(id: number, teamId: number, hp = 100, alive = true): UnitState {
  return {
    id,
    teamId,
    pos: { from: 0, to: 0, progress: 0 },
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

function makeNode(q: number, r = 0, owner: number | null = null): NodeState {
  return { q, r, elevation: 0.5, passable: true, owner, captureProgress: null }
}

function makeState(teams: TeamState[], units: UnitState[], nodes: NodeState[] = [makeNode(0)]): GameState {
  return {
    seed: 1,
    tick: 100,
    config: createConfig({ teamCount: teams.length }),
    nodes,
    neighbors: nodes.map(() => []),
    teams,
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

function emptyEvents(): TickEvents {
  return {
    combat: [],
    deaths: [],
    eliminatedTeams: [],
    territoryCaptures: [],
    regen: [],
    slipDamage: [],
    abilityActivations: [],
    paintballImpacts: [],
  }
}

const teams2 = (): TeamState[] => [
  { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
  { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
]

describe('applyTickRewards', () => {
  it('applies damage-dealt and damage-taken coefficients to attacker and target', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1)])
    const config = createRewardConfig(2, { damageDealtCoef: 0.1, damageTakenCoef: -0.2, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(
      rewards,
      { ...emptyEvents(), combat: [{ attackerId: 0, targetId: 1, damage: 10 }] },
      state,
      config,
      new Map(),
      new Map(),
    )
    expect(rewards[0]).toBeCloseTo(1.0, 10)
    expect(rewards[1]).toBeCloseTo(-2.0, 10)
  })

  it('applies deathPenalty to the victim and killBonus to every alive unit of the killer team', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1, 0, false)])
    const config = createRewardConfig(2, { deathPenalty: -5, killBonus: 3, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(
      rewards,
      {
        ...emptyEvents(),
        combat: [{ attackerId: 0, targetId: 1, damage: 100 }],
        deaths: [{ unitId: 1, teamId: 1, killerTeamId: 0 }],
      },
      state,
      config,
      new Map(),
      new Map(),
    )
    // target: damageTaken (default coef) + deathPenalty; attacker: damageDealt + killBonus
    expect(rewards[1]).toBeCloseTo(100 * config.damageTakenCoef - 5, 10)
    expect(rewards[0]).toBeCloseTo(100 * config.damageDealtCoef + 3, 10)
  })

  it('credits killBonus to every alive teammate of the killer team, not only the unit that landed the last hit', () => {
    const units = [makeUnit(0, 0), makeUnit(1, 0), makeUnit(2, 0, 100, false), makeUnit(3, 1, 0, false)]
    const state = makeState(teams2(), units)
    const config = createRewardConfig(2, { killBonus: 3, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(
      rewards,
      { ...emptyEvents(), deaths: [{ unitId: 3, teamId: 1, killerTeamId: 0 }] },
      state,
      config,
      new Map(),
      new Map(),
    )
    expect(rewards[0]).toBeCloseTo(3, 10) // alive killer-team unit
    expect(rewards[1]).toBeCloseTo(3, 10) // alive killer-team unit
    expect(rewards[2]).toBeUndefined() // dead killer-team unit, not credited
  })

  it('gives no killBonus when the victim died with no damage attribution (killerTeamId null)', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1, 0, false)])
    const config = createRewardConfig(2, { deathPenalty: -5, killBonus: 3, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(
      rewards,
      { ...emptyEvents(), deaths: [{ unitId: 1, teamId: 1, killerTeamId: null }] },
      state,
      config,
      new Map(),
      new Map(),
    )
    expect(rewards[1]).toBeCloseTo(-5, 10)
    expect(rewards[0]).toBeUndefined()
  })

  it('applies slipDamageCoef to units that took ring slip damage', () => {
    const state = makeState(teams2(), [makeUnit(0, 0)])
    const config = createRewardConfig(2, { slipDamageCoef: -0.05, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(
      rewards,
      { ...emptyEvents(), slipDamage: [{ unitId: 0, damage: 4 }] },
      state,
      config,
      new Map(),
      new Map(),
    )
    expect(rewards[0]).toBeCloseTo(-0.2, 10)
  })

  it('grants survivalReward to every alive unit even with no other events', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1, 100, false)])
    const config = createRewardConfig(2, { survivalReward: 0.01 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), new Map())
    expect(rewards[0]).toBeCloseTo(0.01, 10)
    expect(rewards[1]).toBeUndefined() // dead, no survival reward
  })
})

describe('applyTickRewards: next-ring shaping (ユーザー要望)', () => {
  // nextCenter at world (10,0), nextRadius 1. far: world (0,0), distance 10 -> outside by 9.
  // near: world (9,0), distance 1 -> exactly on the boundary (outside by 0).
  const far = makeNode(0)
  const near = makeNode(9)
  const centerNode = makeNode(10)

  function makeShapingState(unit: UnitState): GameState {
    const state = makeState(teams2(), [unit], [far, near, centerNode])
    state.ring.nextCenter = 2
    state.ring.nextRadius = 1
    return state
  }

  it('gives zero shaping reward on the first tick a unit is seen (no prior potential to diff against)', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 0, to: 0, progress: 0 } // at `far`
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), new Map())
    expect(rewards[0]).toBeUndefined()
  })

  it('rewards getting closer to the next ring across ticks, using a persistent memo', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 0, to: 0, progress: 0 } // at `far`: distanceOutside = 9
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    const memo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, memo, new Map()) // first tick: establishes baseline, no reward
    unit.pos = { from: 1, to: 1, progress: 0 } // moves to `near`: distanceOutside = 0
    applyTickRewards(rewards, emptyEvents(), state, config, memo, new Map()) // second tick: improved by 9

    expect(rewards[0]).toBeCloseTo(9, 10)
  })

  it('penalizes moving away from the next ring', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 1, to: 1, progress: 0 } // at `near`: distanceOutside = 0
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    const memo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, memo, new Map())
    unit.pos = { from: 0, to: 0, progress: 0 } // moves to `far`: distanceOutside = 9 (worse)
    applyTickRewards(rewards, emptyEvents(), state, config, memo, new Map())

    expect(rewards[0]).toBeCloseTo(-9, 10)
  })

  it('gives no shaping reward while already at/inside the next ring and staying there', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 1, to: 1, progress: 0 } // at `near`: distanceOutside = 0 throughout
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    const memo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, memo, new Map())
    applyTickRewards(rewards, emptyEvents(), state, config, memo, new Map())

    expect(rewards[0]).toBeUndefined()
  })

  it('is scaled by nextRingShapingCoef', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 0, to: 0, progress: 0 }
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 0.5 })
    const rewards: Record<number, number> = {}
    const memo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, memo, new Map())
    unit.pos = { from: 1, to: 1, progress: 0 }
    applyTickRewards(rewards, emptyEvents(), state, config, memo, new Map())

    expect(rewards[0]).toBeCloseTo(9 * 0.5, 10)
  })

  it("clears each unit's memo entry independently by unit id (a fresh memo means every id starts from zero diff)", () => {
    const unitA = makeUnit(0, 0)
    unitA.pos = { from: 0, to: 0, progress: 0 } // far
    const unitB = makeUnit(1, 1)
    unitB.pos = { from: 1, to: 1, progress: 0 } // near
    const state = makeState(teams2(), [unitA, unitB], [far, near, centerNode])
    state.ring.nextCenter = 2
    state.ring.nextRadius = 1
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), new Map())
    expect(rewards[0]).toBeUndefined()
    expect(rewards[1]).toBeUndefined()
  })
})

describe('applyTickRewards: territory-rate shaping (ユーザー要望: 陣営の目的をマップ占領率にする)', () => {
  it('gives zero shaping reward on the first tick a team is seen (no prior potential to diff against)', () => {
    const nodes = [makeNode(0), makeNode(1)]
    const state = makeState(teams2(), [makeUnit(0, 0)], nodes)
    const config = createRewardConfig(2, { survivalReward: 0, territoryRateShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), new Map())
    expect(rewards[0]).toBeUndefined()
  })

  it("rewards an increase in the team's territory rate across ticks, using a persistent memo", () => {
    const nodes = [makeNode(0), makeNode(1)] // 2 passable nodes total
    const state = makeState(teams2(), [makeUnit(0, 0)], nodes)
    const config = createRewardConfig(2, { survivalReward: 0, territoryRateShapingCoef: 10 })
    const rewards: Record<number, number> = {}
    const territoryMemo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo) // baseline: rate 0
    state.nodes[0].owner = 0 // captures 1 of 2 nodes -> rate 0.5
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo)

    expect(rewards[0]).toBeCloseTo(10 * 0.5, 10)
  })

  it('penalizes losing territory (recapture) as a rate decrease', () => {
    const nodes = [makeNode(0, 0, 0), makeNode(1)] // node 0 starts self-owned -> rate 0.5
    const state = makeState(teams2(), [makeUnit(0, 0)], nodes)
    const config = createRewardConfig(2, { survivalReward: 0, territoryRateShapingCoef: 10 })
    const rewards: Record<number, number> = {}
    const territoryMemo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo) // baseline: rate 0.5
    state.nodes[0].owner = 1 // recaptured by the enemy -> rate 0
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo)

    expect(rewards[0]).toBeCloseTo(10 * (0 - 0.5), 10)
  })

  it('is scaled by territoryRateShapingCoef', () => {
    const nodes = [makeNode(0), makeNode(1)]
    const state = makeState(teams2(), [makeUnit(0, 0)], nodes)
    const config = createRewardConfig(2, { survivalReward: 0, territoryRateShapingCoef: 0.5 })
    const rewards: Record<number, number> = {}
    const territoryMemo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo)
    state.nodes[0].owner = 0
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo)

    expect(rewards[0]).toBeCloseTo(0.5 * 0.5, 10)
  })

  it('credits every alive unit of the team identically, since the potential is team-level', () => {
    const nodes = [makeNode(0), makeNode(1)]
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 0)], nodes)
    const config = createRewardConfig(2, { survivalReward: 0, territoryRateShapingCoef: 10 })
    const rewards: Record<number, number> = {}
    const territoryMemo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo)
    state.nodes[0].owner = 0
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo)

    expect(rewards[0]).toBeCloseTo(5, 10)
    expect(rewards[1]).toBeCloseTo(5, 10)
  })

  it("tracks each team's potential independently by team id", () => {
    const nodes = [makeNode(0), makeNode(1), makeNode(2), makeNode(3)] // 4 passable nodes
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1)], nodes)
    const config = createRewardConfig(2, { survivalReward: 0, territoryRateShapingCoef: 10 })
    const rewards: Record<number, number> = {}
    const territoryMemo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo) // both teams at rate 0
    state.nodes[0].owner = 0 // team 0 -> rate 0.25; team 1 stays at rate 0
    applyTickRewards(rewards, emptyEvents(), state, config, new Map(), territoryMemo)

    expect(rewards[0]).toBeCloseTo(10 * 0.25, 10)
    expect(rewards[1]).toBeUndefined() // team 1's rate did not change
  })
})

describe('applyTerritoryTerminalBonus (ユーザー要望: 陣営の目的をマップ占領率にする)', () => {
  it('does nothing while the game is not yet over', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1)])
    const config = createRewardConfig(2)
    const rewards: Record<number, number> = {}
    applyTerritoryTerminalBonus(rewards, state, config)
    expect(rewards).toEqual({})
  })

  it('awards nothing once every team is fully wiped out, since there is no alive unit left to receive it', () => {
    const teams: TeamState[] = [
      { id: 0, alive: false, eliminatedAtTick: 120, killCount: 0 },
      { id: 1, alive: false, eliminatedAtTick: 100, killCount: 0 },
    ]
    const state = makeState(teams, [makeUnit(0, 0, 0, false), makeUnit(1, 1, 0, false)])
    const config = createRewardConfig(2)
    const rewards: Record<number, number> = {}
    applyTerritoryTerminalBonus(rewards, state, config)
    expect(rewards).toEqual({})
  })

  it("awards the sole surviving team (game ended via the last-team countdown) its territory-rank + territory-rate bonus", () => {
    const teams: TeamState[] = [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
    ]
    const nodes = [makeNode(0, 0, 0), makeNode(1)] // team 0 owns 1 of 2 passable nodes -> rate 0.5
    const state = makeState(teams, [makeUnit(0, 0), makeUnit(1, 1, 0, false)], nodes)
    const config = createRewardConfig(2, { territoryRankBonus: [10, 2], territoryRateTerminalCoef: 20 })
    state.tick = state.config.lastTeamCountdownTicks + 50 // well past the solo-survivor countdown
    const rewards: Record<number, number> = {}
    applyTerritoryTerminalBonus(rewards, state, config)
    // team 0 is the sole survivor (rank 0, territoryRate 0.5): 10 + 20*0.5 = 20
    expect(rewards[0]).toBeCloseTo(20, 10)
    expect(rewards[1]).toBeUndefined() // team 1 has no alive units left to receive it
  })
})
