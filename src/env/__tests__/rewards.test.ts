import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, TeamState, TickEvents, UnitState } from '../../sim'
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

function makeNode(q: number, r = 0): NodeState {
  return { q, r, elevation: 0.5, passable: true, owner: null, captureProgress: null }
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
    applyTickRewards(rewards, { ...emptyEvents(), combat: [{ attackerId: 0, targetId: 1, damage: 10 }] }, state, config, new Map())
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
    applyTickRewards(rewards, { ...emptyEvents(), deaths: [{ unitId: 3, teamId: 1, killerTeamId: 0 }] }, state, config, new Map())
    expect(rewards[0]).toBeCloseTo(3, 10) // alive killer-team unit
    expect(rewards[1]).toBeCloseTo(3, 10) // alive killer-team unit
    expect(rewards[2]).toBeUndefined() // dead killer-team unit, not credited
  })

  it('gives no killBonus when the victim died with no damage attribution (killerTeamId null)', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1, 0, false)])
    const config = createRewardConfig(2, { deathPenalty: -5, killBonus: 3, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, { ...emptyEvents(), deaths: [{ unitId: 1, teamId: 1, killerTeamId: null }] }, state, config, new Map())
    expect(rewards[1]).toBeCloseTo(-5, 10)
    expect(rewards[0]).toBeUndefined()
  })

  it('credits every alive teammate of the capturing team on a territory capture, but not the enemy or dead teammates', () => {
    const units = [makeUnit(0, 0), makeUnit(1, 0, 100, false), makeUnit(2, 1)]
    const state = makeState(teams2(), units)
    const config = createRewardConfig(2, { territoryCoef: 0.5, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, { ...emptyEvents(), territoryCaptures: [{ node: 0, teamId: 0 }] }, state, config, new Map())
    expect(rewards[0]).toBeCloseTo(0.5, 10)
    expect(rewards[1]).toBeUndefined() // dead teammate, not credited
    expect(rewards[2]).toBeUndefined() // enemy team, not credited
  })

  it('applies slipDamageCoef to units that took ring slip damage', () => {
    const state = makeState(teams2(), [makeUnit(0, 0)])
    const config = createRewardConfig(2, { slipDamageCoef: -0.05, survivalReward: 0 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, { ...emptyEvents(), slipDamage: [{ unitId: 0, damage: 4 }] }, state, config, new Map())
    expect(rewards[0]).toBeCloseTo(-0.2, 10)
  })

  it('grants survivalReward to every alive unit even with no other events', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1, 100, false)])
    const config = createRewardConfig(2, { survivalReward: 0.01 })
    const rewards: Record<number, number> = {}
    applyTickRewards(rewards, emptyEvents(), state, config, new Map())
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
    applyTickRewards(rewards, { ...emptyEvents(), eliminatedTeams: [1] }, state, config, new Map())
    // team 1 is last place (rank index 1) among 2 teams
    expect(rewards[1]).toBeCloseTo(config.rankBonus[1], 10)
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
    applyTickRewards(rewards, emptyEvents(), state, config, new Map())
    expect(rewards[0]).toBeUndefined()
  })

  it('rewards getting closer to the next ring across ticks, using a persistent memo', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 0, to: 0, progress: 0 } // at `far`: distanceOutside = 9
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    const memo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, memo) // first tick: establishes baseline, no reward
    unit.pos = { from: 1, to: 1, progress: 0 } // moves to `near`: distanceOutside = 0
    applyTickRewards(rewards, emptyEvents(), state, config, memo) // second tick: improved by 9

    expect(rewards[0]).toBeCloseTo(9, 10)
  })

  it('penalizes moving away from the next ring', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 1, to: 1, progress: 0 } // at `near`: distanceOutside = 0
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    const memo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, memo)
    unit.pos = { from: 0, to: 0, progress: 0 } // moves to `far`: distanceOutside = 9 (worse)
    applyTickRewards(rewards, emptyEvents(), state, config, memo)

    expect(rewards[0]).toBeCloseTo(-9, 10)
  })

  it('gives no shaping reward while already at/inside the next ring and staying there', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 1, to: 1, progress: 0 } // at `near`: distanceOutside = 0 throughout
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 1 })
    const rewards: Record<number, number> = {}
    const memo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, memo)
    applyTickRewards(rewards, emptyEvents(), state, config, memo)

    expect(rewards[0]).toBeUndefined()
  })

  it('is scaled by nextRingShapingCoef', () => {
    const unit = makeUnit(0, 0)
    unit.pos = { from: 0, to: 0, progress: 0 }
    const state = makeShapingState(unit)
    const config = createRewardConfig(2, { survivalReward: 0, nextRingShapingCoef: 0.5 })
    const rewards: Record<number, number> = {}
    const memo = new Map<number, number>()

    applyTickRewards(rewards, emptyEvents(), state, config, memo)
    unit.pos = { from: 1, to: 1, progress: 0 }
    applyTickRewards(rewards, emptyEvents(), state, config, memo)

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
    applyTickRewards(rewards, emptyEvents(), state, config, new Map())
    expect(rewards[0]).toBeUndefined()
    expect(rewards[1]).toBeUndefined()
  })
})

describe('applyWinnerBonus', () => {
  // ユーザー要望で`isGameOver`の終了条件が「全チーム全滅」に変わったため(sim/rules.ts参照)、
  // 「生存チームが1つだけ」はもう`isGameOver`が成立する状態ではない(残り1チームもリング
  // ダメージで全滅するまで自由に占領を続けられる)。よってこのシナリオではボーナスは付与されない。
  it('does not award a bonus for a sole surviving team, since that no longer counts as game-over', () => {
    const teams: TeamState[] = [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: false, eliminatedAtTick: 100, killCount: 0 },
    ]
    const state = makeState(teams, [makeUnit(0, 0), makeUnit(1, 1, 0, false)])
    const config = createRewardConfig(2)
    const rewards: Record<number, number> = {}
    applyWinnerBonus(rewards, state, config)
    expect(rewards).toEqual({})
  })

  it('does nothing while the game is not yet over', () => {
    const state = makeState(teams2(), [makeUnit(0, 0), makeUnit(1, 1)])
    const config = createRewardConfig(2)
    const rewards: Record<number, number> = {}
    applyWinnerBonus(rewards, state, config)
    expect(rewards).toEqual({})
  })

  // 全チーム全滅が新しい終了条件になったため、isGameOverが成立する時点では「生存している勝者」が
  // 存在し得ず、この関数は事実上常に無効化されている(RL報酬の再設計は保留中の既知のギャップ —
  // 学習をやり直す際に見直す)。
  it('still does nothing once every team is eliminated, since there is no longer an alive winner to reward', () => {
    const teams: TeamState[] = [
      { id: 0, alive: false, eliminatedAtTick: 120, killCount: 0 },
      { id: 1, alive: false, eliminatedAtTick: 100, killCount: 0 },
    ]
    const state = makeState(teams, [makeUnit(0, 0, 0, false), makeUnit(1, 1, 0, false)])
    const config = createRewardConfig(2)
    const rewards: Record<number, number> = {}
    applyWinnerBonus(rewards, state, config)
    expect(rewards).toEqual({})
  })
})
