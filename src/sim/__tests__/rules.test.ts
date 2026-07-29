import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import type { GameState, NodeState, SimConfig, TeamState, UnitState } from '../types'
import {
  getRanking,
  getTerritoryRanking,
  getWinnerTeamId,
  isGameOver,
  lastTeamCountdownRemaining,
  teamTerritoryRate,
} from '../rules'

function makeNode(owner: number | null = null, passable = true): NodeState {
  return { q: 0, r: 0, elevation: 0.5, passable, owner, captureProgress: null }
}

function makeUnit(id: number, teamId: number, hp: number, alive = true): UnitState {
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

function makeState(
  teams: TeamState[],
  units: UnitState[],
  nodes: NodeState[] = [],
  overrides?: { tick?: number; config?: Partial<SimConfig> },
): GameState {
  return {
    seed: 1,
    tick: overrides?.tick ?? 100,
    config: createConfig(overrides?.config),
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

describe('rules: game over / winner', () => {
  it('is not over with 2+ alive teams and has no single winner', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
      ],
      [],
    )
    expect(isGameOver(state)).toBe(false)
    expect(getWinnerTeamId(state)).toBeNull()
  })

  it('ユーザー要望: is NOT over with exactly one alive team — it can keep painting territory until ring-wiped, but getWinnerTeamId still identifies the sole survivor', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
      ],
      [],
    )
    expect(isGameOver(state)).toBe(false)
    expect(getWinnerTeamId(state)).toBe(0)
  })

  it('is over only once every team has been eliminated', () => {
    const state = makeState(
      [
        { id: 0, alive: false, eliminatedAtTick: 80, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
      ],
      [],
    )
    expect(isGameOver(state)).toBe(true)
    expect(getWinnerTeamId(state)).toBeNull()
  })
})

describe('rules: ranking', () => {
  it('ranks a still-alive team above one eliminated earlier', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
      ],
      [],
    )
    expect(getRanking(state)).toEqual([0, 1])
  })

  it('ranks a team eliminated later above one eliminated earlier', () => {
    const state = makeState(
      [
        { id: 0, alive: false, eliminatedAtTick: 30, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 80, killCount: 0 },
      ],
      [],
    )
    expect(getRanking(state)).toEqual([1, 0])
  })

  it('breaks a same-elimination-tick tie by total HP descending', () => {
    const state = makeState(
      [
        { id: 0, alive: false, eliminatedAtTick: 40, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 40, killCount: 0 },
      ],
      [makeUnit(0, 0, 10), makeUnit(1, 1, 90)],
    )
    expect(getRanking(state)).toEqual([1, 0])
  })

  it('falls through to territory count when HP is tied too', () => {
    const state = makeState(
      [
        { id: 0, alive: false, eliminatedAtTick: 40, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 40, killCount: 0 },
      ],
      [makeUnit(0, 0, 50), makeUnit(1, 1, 50)],
      [makeNode(0), makeNode(0), makeNode(1)],
    )
    expect(getRanking(state)).toEqual([0, 1])
  })

  it('is stable/deterministic when every other tiebreak is equal', () => {
    const state = makeState(
      [
        { id: 0, alive: false, eliminatedAtTick: 40, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 40, killCount: 0 },
      ],
      [makeUnit(0, 0, 50), makeUnit(1, 1, 50)],
    )
    const a = getRanking(state)
    const b = getRanking(state)
    expect(a).toEqual(b)
    expect(new Set(a)).toEqual(new Set([0, 1]))
  })
})

describe('rules: territory rate / ranking (ユーザー要望: 陣営の目的をマップ占領率にする)', () => {
  it('computes owned/passable ratio, excluding wall nodes from the denominator', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
      ],
      [],
      [makeNode(0), makeNode(0), makeNode(1), makeNode(null), makeNode(null, false)],
    )
    // 4 passable nodes total (the wall is excluded); team 0 owns 2 of them.
    expect(teamTerritoryRate(state, 0)).toBeCloseTo(0.5, 10)
    expect(teamTerritoryRate(state, 1)).toBeCloseTo(0.25, 10)
  })

  it('is 0 when the map has no passable nodes', () => {
    const state = makeState(
      [{ id: 0, alive: true, eliminatedAtTick: null, killCount: 0 }],
      [],
      [makeNode(null, false)],
    )
    expect(teamTerritoryRate(state, 0)).toBe(0)
  })

  it('ranks by territory rate descending, ignoring elimination order entirely', () => {
    const state = makeState(
      [
        { id: 0, alive: false, eliminatedAtTick: 30, killCount: 0 }, // eliminated early but holds more territory
        { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
      ],
      [],
      [makeNode(0), makeNode(0), makeNode(0), makeNode(1)],
    )
    expect(getTerritoryRanking(state)).toEqual([0, 1])
  })

  it('breaks an exact territory tie by ascending team id', () => {
    const state = makeState(
      [
        { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      ],
      [],
      [makeNode(0), makeNode(1)],
    )
    expect(getTerritoryRanking(state)).toEqual([0, 1])
  })
})

describe('rules: last-team countdown (ユーザー要望: 残り1チームになってから終了までのカウントダウン)', () => {
  it('is null (no countdown) while 2+ teams are alive', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
      ],
      [],
    )
    expect(lastTeamCountdownRemaining(state)).toBeNull()
  })

  it('is null once every team is eliminated (already game over via full wipe)', () => {
    const state = makeState([
      { id: 0, alive: false, eliminatedAtTick: 80, killCount: 0 },
      { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
    ], [])
    expect(lastTeamCountdownRemaining(state)).toBeNull()
  })

  it('counts down from the tick the last other team was eliminated, and stays alive within the window', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
      ],
      [],
      [],
      { tick: 55, config: { lastTeamCountdownTicks: 20 } },
    )
    expect(lastTeamCountdownRemaining(state)).toBe(15) // 20 - (55 - 50)
    expect(isGameOver(state)).toBe(false)
  })

  it('ends the game exactly when the countdown elapses', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
      ],
      [],
      [],
      { tick: 70, config: { lastTeamCountdownTicks: 20 } },
    )
    expect(lastTeamCountdownRemaining(state)).toBe(0)
    expect(isGameOver(state)).toBe(true)
  })

  it('clamps remaining at 0 rather than going negative once past the threshold', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
      ],
      [],
      [],
      { tick: 500, config: { lastTeamCountdownTicks: 20 } },
    )
    expect(lastTeamCountdownRemaining(state)).toBe(0)
    expect(isGameOver(state)).toBe(true)
  })

  it('starts the countdown from tick 0 when there was never more than one team', () => {
    const state = makeState([{ id: 0, alive: true, eliminatedAtTick: null, killCount: 0 }], [], [], {
      tick: 10,
      config: { lastTeamCountdownTicks: 20 },
    })
    expect(lastTeamCountdownRemaining(state)).toBe(10) // 20 - (10 - 0)
    expect(isGameOver(state)).toBe(false)
  })
})
