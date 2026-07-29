import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import type { GameState, UnitState } from '../types'
import { applyMovementIntent, computeMovementIntent } from '../movement'

/** A straight 3-node line: 0 - 1 - 2, all passable. Lets tests reason about exact tick counts. */
function makeLineState(seed: number, overrides?: Partial<GameState['config']>): GameState {
  const config = createConfig({ baseSpeed: 0.3, territoryMoveBonus: 0.5, ...overrides })
  return {
    seed,
    tick: 0,
    config,
    nodes: [
      { q: 0, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null },
      { q: 1, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null },
      { q: 2, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null },
    ],
    neighbors: [[1], [0, 2], [1]],
    teams: [{ id: 0, alive: true, eliminatedAtTick: null, killCount: 0 }],
    units: [makeUnit(0, 0)],
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

function makeUnit(id: number, atNode: number): UnitState {
  return {
    id,
    teamId: 0,
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

function tick(state: GameState): number[] {
  state.tick++
  const unit = state.units[0]
  const intent = computeMovementIntent(state, unit)
  return intent ? applyMovementIntent(state, unit, intent) : []
}

describe('movement', () => {
  it('reaches an adjacent node after the expected number of ticks and clears destination', () => {
    const state = makeLineState(1)
    state.units[0].command = { type: 'moveTo', node: 1 }

    // baseSpeed=0.3 -> 4 ticks to cover progress 1.0 (0.3*3=0.9, 0.3*4=1.2 overshoots to arrival)
    tick(state)
    tick(state)
    tick(state)
    expect(state.units[0].pos).toEqual({ from: 0, to: 1, progress: expect.closeTo(0.9, 10) })

    tick(state)
    expect(state.units[0].pos).toEqual({ from: 1, to: 1, progress: 0 })
    expect(state.units[0].destination).toBeNull()
    expect(state.units[0].path).toBeNull()
  })

  it('follows a multi-hop path to a non-adjacent destination', () => {
    const state = makeLineState(2)
    state.units[0].command = { type: 'moveTo', node: 2 }

    const atRest = () => state.units[0].pos.from === 2 && state.units[0].pos.to === 2
    for (let i = 0; i < 20 && !atRest(); i++) tick(state)

    expect(state.units[0].pos).toEqual({ from: 2, to: 2, progress: 0 })
    expect(state.units[0].destination).toBeNull()
  })

  it('reverses direction mid-edge when the destination changes to require backtracking', () => {
    const state = makeLineState(3)
    state.units[0].command = { type: 'moveTo', node: 1 }
    tick(state) // progress 0.3 toward node 1
    expect(state.units[0].pos).toEqual({ from: 0, to: 1, progress: expect.closeTo(0.3, 10) })

    // Change destination back to node 0 while mid-edge. Inspect the Read-phase intent directly
    // (rather than applying it) so arriving-in-the-same-tick doesn't mask the reversal itself:
    // mirroring progress 0.3 forward becomes 0.7 back toward 0, which one more tick of speed
    // 0.3 would complete — a real and correct outcome, just not what we're isolating here.
    state.units[0].command = { type: 'moveTo', node: 0 }
    const intent = computeMovementIntent(state, state.units[0])

    expect(intent?.from).toBe(1)
    expect(intent?.to).toBe(0)
    expect(intent?.progress).toBeCloseTo(0.7, 10)
  })

  it('moveDirection steps onto the correct neighbor when standing on a node', () => {
    const state = makeLineState(4)
    state.units[0].command = { type: 'moveDirection', dir: 0 } // DIRECTIONS[0] = (+1, 0)
    tick(state)
    expect(state.units[0].pos.to).toBe(1)
  })

  it('moveDirection is ignored (current edge continues) while mid-edge', () => {
    const state = makeLineState(5)
    state.units[0].command = { type: 'moveTo', node: 1 }
    tick(state)
    expect(state.units[0].pos.from).toBe(0)
    expect(state.units[0].pos.to).toBe(1)
    const progressAfterFirstTick = state.units[0].pos.progress

    state.units[0].command = { type: 'moveDirection', dir: 3 } // would point back to node 0
    tick(state)
    // Still progressing toward 1, not reversed by the ignored direction command.
    expect(state.units[0].pos.from).toBe(0)
    expect(state.units[0].pos.to).toBe(1)
    expect(state.units[0].pos.progress).toBeGreaterThan(progressAfterFirstTick)
  })

  it('applies the territory move-speed bonus only when both edge endpoints are owned by self', () => {
    const state = makeLineState(6)
    state.units[0].command = { type: 'moveTo', node: 1 }

    const baseline = computeMovementIntent(state, state.units[0])
    expect(baseline?.speed).toBeCloseTo(state.config.baseSpeed, 10)

    state.nodes[0].owner = 0
    state.nodes[1].owner = 0
    const boosted = computeMovementIntent(state, state.units[0])
    expect(boosted?.speed).toBeCloseTo(state.config.baseSpeed * (1 + state.config.territoryMoveBonus), 10)
  })

  it('does not apply the bonus when only one endpoint is owned by self', () => {
    const state = makeLineState(7)
    state.units[0].command = { type: 'moveTo', node: 1 }
    state.nodes[1].owner = 0 // destination owned, but origin is not

    const intent = computeMovementIntent(state, state.units[0])
    expect(intent?.speed).toBeCloseTo(state.config.baseSpeed, 10)
  })

  it('idle units pick a deterministic random exploration destination', () => {
    const stateA = makeLineState(42)
    const stateB = makeLineState(42)
    const intentA = computeMovementIntent(stateA, stateA.units[0])
    const intentB = computeMovementIntent(stateB, stateB.units[0])

    expect(intentA?.destination).not.toBeNull()
    expect(intentA?.destination).toBe(intentB?.destination)
  })

  it('reports an intermediate node as visited even when the unit continues past it within the same tick', () => {
    const state = makeLineState(9)
    state.units[0].command = { type: 'moveTo', node: 2 }

    // baseSpeed=0.3: ticks 1-3 stay mid-edge 0->1 (progress 0.3, 0.6, 0.9); tick 4 overshoots
    // past node 1 (arriving and immediately continuing toward node 2 within the same tick), so
    // unit.pos never records from===to===1 even though the unit was genuinely there this tick.
    expect(tick(state)).toEqual([])
    expect(tick(state)).toEqual([])
    expect(tick(state)).toEqual([])
    const visited = tick(state)
    expect(visited).toEqual([1])
    expect(state.units[0].pos).toEqual({ from: 1, to: 2, progress: expect.closeTo(0.5, 10) })
  })

  it('reports the final destination node as visited when the journey ends exactly on it', () => {
    const state = makeLineState(10)
    state.units[0].command = { type: 'moveTo', node: 1 }
    tick(state)
    tick(state)
    tick(state)
    const visited = tick(state) // arrives with no further path -> should stop here
    expect(visited).toEqual([1])
    expect(state.units[0].pos).toEqual({ from: 1, to: 1, progress: 0 })
  })

  it('reports no visited nodes for a wait (no movement) tick', () => {
    const state = makeLineState(11)
    // idle with a destination already equal to current node resolves to an empty path -> wait
    state.units[0].destination = 0
    state.units[0].path = []
    expect(tick(state)).toEqual([])
  })

  it('does not move a dead unit', () => {
    const state = makeLineState(8)
    state.units[0].alive = false
    state.units[0].command = { type: 'moveTo', node: 2 }
    expect(computeMovementIntent(state, state.units[0])).toBeNull()
  })
})
