import { describe, expect, it } from 'vitest'
import { createConfig, generateMap, initRingState } from '../../sim'
import type { GameState, SimConfig, UnitState } from '../../sim'
import { BOT_KINDS, createTeamRoutedDecisionSource, defaultBotKindForTeam } from '../teamAssignment'
import { decideCommands as decideExpander } from '../expanderBot'
import { decideCommands as decideGuardian } from '../guardianBot'
import { decideCommands as decideRaider } from '../raiderBot'

function makeUnit(id: number, teamId: number, atNode: number): UnitState {
  return {
    id,
    teamId,
    pos: { from: atNode, to: atNode, progress: 0 },
    hp: 100,
    alive: true,
    command: { type: 'idle' },
    attackTarget: null,
    destination: null,
    path: null,
    lastDamagedByTeamId: null,
  }
}

function makeState(seed: number, overrides?: Partial<SimConfig>): GameState {
  const config = createConfig({ mapRadius: 4, wallThreshold: 0, visionRange: 2.0, attackRange: 2.0, ...overrides })
  const { nodes, neighbors } = generateMap(seed, config)
  return {
    seed,
    tick: 0,
    config,
    nodes,
    neighbors,
    teams: [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
    ],
    units: [],
    ring: initRingState(seed, config, nodes),
  }
}

function nodeAt(state: GameState, q: number, r: number): number {
  const idx = state.nodes.findIndex((n) => n.q === q && n.r === r)
  if (idx === -1) throw new Error(`no node at (${q},${r})`)
  return idx
}

describe('BOT_KINDS / defaultBotKindForTeam (ユーザー要望: 既定値はチームNo. mod n)', () => {
  it('has exactly 3 kinds (expander, guardian, raider)', () => {
    expect(BOT_KINDS).toEqual(['expander', 'guardian', 'raider'])
  })

  it('cycles team ids through BOT_KINDS by mod', () => {
    for (let teamId = 0; teamId < 7; teamId++) {
      expect(defaultBotKindForTeam(teamId)).toBe(BOT_KINDS[teamId % BOT_KINDS.length])
    }
  })
})

describe('createTeamRoutedDecisionSource', () => {
  it('routes each team to its assigned bot and merges the results', () => {
    const state = makeState(1)
    const team0Node = nodeAt(state, 0, 0)
    const team1Node = nodeAt(state, 3, 0) // far enough apart that visionRange(2.0) keeps them mutually invisible
    state.ring.activeRadius = 100
    state.units = [makeUnit(0, 0, team0Node), makeUnit(1, 1, team1Node)]

    const source = createTeamRoutedDecisionSource(new Map([[0, 'raider']]))
    const decisions = source(state, [0, 1])

    // team 0 explicitly assigned 'raider'.
    expect(decisions.get(0)).toEqual(decideRaider(state, [0]).get(0))
    // team 1 unassigned -> falls back to defaultBotKindForTeam(1) = BOT_KINDS[1] = 'guardian'.
    expect(defaultBotKindForTeam(1)).toBe('guardian')
    expect(decisions.get(1)).toEqual(decideGuardian(state, [1]).get(1))
  })

  it('falls back to defaultBotKindForTeam (mod n) for every team when the assignment map is empty', () => {
    const state = makeState(2)
    const team0Node = nodeAt(state, 0, 0)
    state.units = [makeUnit(0, 0, team0Node)]

    const source = createTeamRoutedDecisionSource(new Map())
    const decisions = source(state, [0])

    expect(defaultBotKindForTeam(0)).toBe('expander')
    expect(decisions.get(0)).toEqual(decideExpander(state, [0]).get(0))
  })

  it('routes multiple units on the same team together and includes all of them', () => {
    const state = makeState(3)
    const nodeA = nodeAt(state, 0, 0)
    const nodeB = nodeAt(state, -1, 0)
    state.units = [makeUnit(0, 0, nodeA), makeUnit(1, 0, nodeB)]

    const source = createTeamRoutedDecisionSource(new Map([[0, 'guardian']]))
    const decisions = source(state, [0, 1])

    expect(decisions.has(0)).toBe(true)
    expect(decisions.has(1)).toBe(true)
  })

  it('silently ignores unit ids that no longer exist in state', () => {
    const state = makeState(4)
    const team0Node = nodeAt(state, 0, 0)
    state.units = [makeUnit(0, 0, team0Node)]

    const source = createTeamRoutedDecisionSource(new Map())
    const decisions = source(state, [0, 999])

    expect(decisions.has(0)).toBe(true)
    expect(decisions.has(999)).toBe(false)
  })
})
