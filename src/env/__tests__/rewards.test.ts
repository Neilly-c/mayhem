import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, TeamState, TickEvents, UnitState } from '../../sim'
import { createRewardConfig } from '../rewardConfig'
import { applyTickRewards, applyWinnerBonus } from '../rewards'

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
  }
}

function makeState(teams: TeamState[], units: UnitState[]): GameState {
  return {
    seed: 1,
    tick: 100,
    config: createConfig({ teamCount: teams.length }),
    nodes: [],
    neighbors: [],
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
  }
}

function emptyEvents(): TickEvents {
  return { combat: [], deaths: [], eliminatedTeams: [], territoryCaptures: [], regen: [], slipDamage: [] }
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
    applyTickRewards(rewards, { ...emptyEvents(), combat: [{ attackerId: 0, targetId: 1, damage: 10 }] }, state, config)
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
    applyTickRewards(rewards, { ...emptyEvents(), deaths: [{ unitId: 3, teamId: 1, killerTeamId: 0 }] }, state, config)
    expect(rewards[0]).toBeCloseTo(3, 10) // alive killer-team unit
    expect(rewards[1]).toBeCloseTo(3, 10) // alive killer-team unit
    expect(rewards[2]).toBeUndefined() // dead killer-team unit, not credited
  })

  it('gives no killBonus when the victim died with no damage attribution (killerTeamId null)', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1, 0, false)])
    const config = createRewardConfig(2, { deathPenalty: -5, killBonus: 3, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, { ...emptyEvents(), deaths: [{ unitId: 1, teamId: 1, killerTeamId: null }] }, state, config)
    expect(rewards[1]).toBeCloseTo(-5, 10)
    expect(rewards[0]).toBeUndefined()
  })

  it('credits every alive teammate of the capturing team on a territory capture, but not the enemy or dead teammates', () => {
    const units = [makeUnit(0, 0), makeUnit(1, 0, 100, false), makeUnit(2, 1)]
    const state = makeState(teams2(), units)
    const config = createRewardConfig(2, { territoryCoef: 0.5, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, { ...emptyEvents(), territoryCaptures: [{ node: 0, teamId: 0 }] }, state, config)
    expect(rewards[0]).toBeCloseTo(0.5, 10)
    expect(rewards[1]).toBeUndefined() // dead teammate, not credited
    expect(rewards[2]).toBeUndefined() // enemy team, not credited
  })

  it('applies slipDamageCoef to units that took ring slip damage', () => {
    const state = makeState(teams2(), [makeUnit(0, 0)])
    const config = createRewardConfig(2, { slipDamageCoef: -0.05, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, { ...emptyEvents(), slipDamage: [{ unitId: 0, damage: 4 }] }, state, config)
    expect(rewards[0]).toBeCloseTo(-0.2, 10)
  })

  it('grants survivalReward to every alive unit even with no other events', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1, 100, false)])
    const config = createRewardConfig(2, { survivalReward: 0.01 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, emptyEvents(), state, config)
    expect(rewards[0]).toBeCloseTo(0.01, 10)
    expect(rewards[1]).toBeUndefined() // dead, no survival reward
  })

  it('awards the rank-appropriate bonus when a team is eliminated this tick', () => {
    const teams: TeamState[] = [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: false, eliminatedAtTick: 100, killCount: 0 }, // just eliminated this tick
    ]
    const state = makeState(teams, [makeUnit(0, 0), makeUnit(1, 1, 0, false)])
    // Explicit non-zero last-place bonus so this test isn't masked by add()'s zero-amount skip.
    const config = createRewardConfig(2, { survivalReward: 0, rankBonus: [10, 2] })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, { ...emptyEvents(), eliminatedTeams: [1] }, state, config)
    // team 1 is last place (rank index 1) among 2 teams
    expect(rewards[1]).toBeCloseTo(config.rankBonus[1], 10)
  })
})

describe('applyWinnerBonus', () => {
  it('awards the top rank bonus to the sole surviving team, once', () => {
    const teams: TeamState[] = [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: false, eliminatedAtTick: 100, killCount: 0 },
    ]
    const state = makeState(teams, [makeUnit(0, 0), makeUnit(1, 1, 0, false)])
    const config = createRewardConfig(2)
    const rewards: Record<number, number> = {}
    applyWinnerBonus(rewards, state, config)
    expect(rewards[0]).toBeCloseTo(config.rankBonus[0], 10)
    expect(rewards[1]).toBeUndefined()
  })

  it('does nothing while the game is not yet over', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1)])
    const config = createRewardConfig(2)
    const rewards: Record<number, number> = {}
    applyWinnerBonus(rewards, state, config)
    expect(rewards).toEqual({})
  })
})
