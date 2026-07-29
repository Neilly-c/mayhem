import { describe, expect, it } from 'vitest'
import { DIRECTIONS, axialAdd, createConfig, generateMap, initRingState } from '../../sim'
import type { GameState, SimConfig, UnitState } from '../../sim'
import type { MoveCommand } from '../../sim'
import { ActorCriticModel } from '../network'
import { createPolicyDecisionSource } from '../policyDecisionSource'
import { inferObsDim } from '../shapes'

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
  }
}

/** wallThreshold:0 -> every generated node passable, giving a real hex disk with true 6-neighbor geometry. */
function makeState(seed: number, overrides?: Partial<SimConfig>): GameState {
  const config = createConfig({
    mapRadius: 3,
    wallThreshold: 0,
    visionRange: 100,
    attackRange: 2,
    maxVisibleEnemies: 3,
    ...overrides,
  })
  const { nodes, neighbors } = generateMap(seed, config)
  const state: GameState = {
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
  state.ring.activeRadius = 100
  return state
}

function nodeAt(state: GameState, q: number, r: number): number {
  const idx = state.nodes.findIndex((n) => n.q === q && n.r === r)
  if (idx === -1) throw new Error(`no node at (${q},${r})`)
  return idx
}

function buildModelFor(config: SimConfig): ActorCriticModel {
  const obsDim = inferObsDim(config, 1)
  return ActorCriticModel.build({ obsDim, maxVisibleEnemies: config.maxVisibleEnemies, hiddenSizes: [8] })
}

function isLegalMoveCommand(state: GameState, unit: UnitState, command: MoveCommand): boolean {
  if (command.type === 'idle') return true
  if (command.type === 'moveTo') return state.nodes[command.node]?.passable ?? false
  // moveDirection
  const node = state.nodes[unit.pos.to]
  const target = axialAdd({ q: node.q, r: node.r }, DIRECTIONS[command.dir])
  return state.neighbors[unit.pos.to].some((n) => state.nodes[n].q === target.q && state.nodes[n].r === target.r)
}

describe('policyDecisionSource', () => {
  it('never issues a move into a nonexistent neighbor (respects the move mask) even from a map-edge node', () => {
    const state = makeState(1)
    // (3,0) is on the outer edge of a mapRadius:3 disk -> several directions have no neighbor at all.
    const selfNode = nodeAt(state, 3, 0)
    state.units = [makeUnit(0, 0, selfNode)]
    const model = buildModelFor(state.config)
    const source = createPolicyDecisionSource(model)

    const decisions = source(state, [0])
    const command = decisions.get(0)?.command
    expect(command).toBeDefined()
    expect(isLegalMoveCommand(state, state.units[0], command!)).toBe(true)
  })

  it('never targets an enemy that is visible but out of attack range', () => {
    const state = makeState(2, { attackRange: 2 })
    const selfNode = nodeAt(state, 0, 0)
    const enemyNode = nodeAt(state, 3, 0) // world distance 3.0 > attackRange 2.0, but within visionRange 100
    state.units = [makeUnit(0, 0, selfNode), makeUnit(1, 1, enemyNode)]
    const model = buildModelFor(state.config)
    const source = createPolicyDecisionSource(model)

    const decisions = source(state, [0])
    expect(decisions.get(0)?.attackTarget).toBeNull()
  })

  it('targets the visible in-range enemy only when the deterministic argmax actually picks the attack head', () => {
    // Not asserting *that* it attacks (an untrained/random network may or may not) — only that
    // *if* it does, the target is the legal one. Run across several seeds/models to exercise both branches.
    const state = makeState(3, { attackRange: 5 })
    const selfNode = nodeAt(state, 0, 0)
    const enemyNode = nodeAt(state, 1, 0) // within attackRange 5
    state.units = [makeUnit(0, 0, selfNode), makeUnit(1, 1, enemyNode)]

    for (let seed = 0; seed < 5; seed++) {
      const model = ActorCriticModel.build({
        obsDim: inferObsDim(state.config, 1),
        maxVisibleEnemies: state.config.maxVisibleEnemies,
        hiddenSizes: [4 + seed],
      })
      const source = createPolicyDecisionSource(model)
      const decisions = source(state, [0])
      const target = decisions.get(0)?.attackTarget
      expect(target === null || target === 1).toBe(true)
    }
  })

  it('skips dead and unknown units', () => {
    const state = makeState(4)
    const selfNode = nodeAt(state, 0, 0)
    state.units = [makeUnit(0, 0, selfNode, 100, false)]
    const model = buildModelFor(state.config)
    const source = createPolicyDecisionSource(model)

    const decisions = source(state, [0, 999])
    expect(decisions.size).toBe(0)
  })

  it('returns an empty map without crashing when given no unit ids', () => {
    const state = makeState(5)
    const model = buildModelFor(state.config)
    const source = createPolicyDecisionSource(model)

    expect(source(state, [])).toEqual(new Map())
  })

  it('deterministic mode (default) is reproducible: same state -> same decision', () => {
    const state = makeState(6)
    const selfNode = nodeAt(state, 0, 0)
    const enemyNode = nodeAt(state, 1, 0)
    state.units = [makeUnit(0, 0, selfNode), makeUnit(1, 1, enemyNode)]
    const model = buildModelFor(state.config)
    const source = createPolicyDecisionSource(model)

    const first = source(state, [0]).get(0)
    const second = source(state, [0]).get(0)
    expect(second).toEqual(first)
  })

  it('handles a batch of multiple units from the same team in one call', () => {
    const state = makeState(7)
    const nodeA = nodeAt(state, 0, 0)
    const nodeB = nodeAt(state, -1, 0)
    state.units = [makeUnit(0, 0, nodeA), makeUnit(1, 0, nodeB)]
    const model = buildModelFor(state.config)
    const source = createPolicyDecisionSource(model)

    const decisions = source(state, [0, 1])
    expect(decisions.size).toBe(2)
    expect(decisions.has(0)).toBe(true)
    expect(decisions.has(1)).toBe(true)
  })
})
