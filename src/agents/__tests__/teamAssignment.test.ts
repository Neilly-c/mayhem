import { describe, expect, it } from 'vitest'
import { createConfig, generateMap, initRingState } from '../../sim'
import type { GameState, SimConfig, UnitState } from '../../sim'
import { createTeamRoutedDecisionSource } from '../teamAssignment'

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

describe('createTeamRoutedDecisionSource', () => {
  it("routes each team to its assigned bot and merges the results", () => {
    const state = makeState(1)
    const team0Node = nodeAt(state, 0, 0)
    const team1Node = nodeAt(state, 3, 0) // far enough apart that visionRange(2.0) keeps them mutually invisible
    state.ring.activeRadius = 100
    state.units = [makeUnit(0, 0, team0Node), makeUnit(1, 1, team1Node)]

    const source = createTeamRoutedDecisionSource(new Map([[0, 'decisionTree']]), 'scripted')
    const decisions = source(state, [0, 1])

    // team 0 -> decisionTree: no visible enemy, nothing self-owned yet -> territory expansion (not idle)
    expect(decisions.get(0)?.command).not.toEqual({ type: 'idle' })
    // team 1 -> falls back to the default 'scripted' bot: movement is always idle
    expect(decisions.get(1)?.command).toEqual({ type: 'idle' })
  })

  it('uses defaultBot for every team when the assignment map is empty', () => {
    const state = makeState(2)
    const team0Node = nodeAt(state, 0, 0)
    state.units = [makeUnit(0, 0, team0Node)]

    const source = createTeamRoutedDecisionSource(new Map(), 'scripted')
    const decisions = source(state, [0])

    expect(decisions.get(0)?.command).toEqual({ type: 'idle' })
  })

  it('routes multiple units on the same team together and includes all of them', () => {
    const state = makeState(3)
    const nodeA = nodeAt(state, 0, 0)
    const nodeB = nodeAt(state, -1, 0)
    state.units = [makeUnit(0, 0, nodeA), makeUnit(1, 0, nodeB)]

    const source = createTeamRoutedDecisionSource(new Map([[0, 'decisionTree']]), 'scripted')
    const decisions = source(state, [0, 1])

    expect(decisions.has(0)).toBe(true)
    expect(decisions.has(1)).toBe(true)
  })

  it('silently ignores unit ids that no longer exist in state', () => {
    const state = makeState(4)
    const team0Node = nodeAt(state, 0, 0)
    state.units = [makeUnit(0, 0, team0Node)]

    const source = createTeamRoutedDecisionSource(new Map(), 'scripted')
    const decisions = source(state, [0, 999])

    expect(decisions.has(0)).toBe(true)
    expect(decisions.has(999)).toBe(false)
  })
})
