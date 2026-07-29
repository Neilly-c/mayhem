import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import type { GameState, NodeState, TeamState, UnitState } from '../types'
import { getRanking, getWinnerTeamId, isGameOver } from '../rules'

function makeNode(owner: number | null = null): NodeState {
  return { q: 0, r: 0, elevation: 0.5, passable: true, owner, captureProgress: null }
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

function makeState(teams: TeamState[], units: UnitState[], nodes: NodeState[] = []): GameState {
  return {
    seed: 1,
    tick: 100,
    config: createConfig(),
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

  it('is over with exactly one alive team, which is the winner', () => {
    const state = makeState(
      [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: false, eliminatedAtTick: 50, killCount: 0 },
      ],
      [],
    )
    expect(isGameOver(state)).toBe(true)
    expect(getWinnerTeamId(state)).toBe(0)
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
