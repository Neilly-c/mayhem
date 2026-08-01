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
    projectiles: [],
    nextProjectileId: 0,
    laserBeams: [],
    nextLaserBeamId: 0,
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
    ability: 'paintball',
    abilityCooldownRemaining: 0,
    abilityActiveTicksRemaining: 0,
    abilityCommand: { type: 'none' },
  }
}

function tick(state: GameState): number[] {
  state.tick++
  const unit = state.units[0]
  const claimedTo = new Set(state.units.filter((u) => u.alive && u.id !== unit.id).map((u) => u.pos.to))
  const intent = computeMovementIntent(state, unit, claimedTo)
  return intent ? applyMovementIntent(state, unit, intent, claimedTo) : []
}

/** Mirrors sim.ts's actual multi-unit movement resolution: processes every alive unit in
 * (teamId, unitId) order against one shared, incrementally-updated `claimedTo` set. */
function tickAll(state: GameState): void {
  state.tick++
  const order = state.units.filter((u) => u.alive).sort((a, b) => a.teamId - b.teamId || a.id - b.id)
  const claimedTo = new Set(order.map((u) => u.pos.to))
  for (const unit of order) {
    claimedTo.delete(unit.pos.to)
    const intent = computeMovementIntent(state, unit, claimedTo)
    if (intent) applyMovementIntent(state, unit, intent, claimedTo)
    claimedTo.add(unit.pos.to)
  }
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
    const intent = computeMovementIntent(state, state.units[0], new Set())

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

    const baseline = computeMovementIntent(state, state.units[0], new Set())
    expect(baseline?.speed).toBeCloseTo(state.config.baseSpeed, 10)

    state.nodes[0].owner = 0
    state.nodes[1].owner = 0
    const boosted = computeMovementIntent(state, state.units[0], new Set())
    expect(boosted?.speed).toBeCloseTo(state.config.baseSpeed * (1 + state.config.territoryMoveBonus), 10)
  })

  it('does not apply the bonus when only one endpoint is owned by self', () => {
    const state = makeLineState(7)
    state.units[0].command = { type: 'moveTo', node: 1 }
    state.nodes[1].owner = 0 // destination owned, but origin is not

    const intent = computeMovementIntent(state, state.units[0], new Set())
    expect(intent?.speed).toBeCloseTo(state.config.baseSpeed, 10)
  })

  it('idle units pick a deterministic random exploration destination', () => {
    const stateA = makeLineState(42)
    const stateB = makeLineState(42)
    const intentA = computeMovementIntent(stateA, stateA.units[0], new Set())
    const intentB = computeMovementIntent(stateB, stateB.units[0], new Set())

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
    expect(computeMovementIntent(state, state.units[0], new Set())).toBeNull()
  })
})

/** ユーザー要望: 同一ノードへの複数ユニット共存禁止(味方も含む)の回帰テスト群。 */
describe('movement: shared-node prevention', () => {
  function makeMultiUnitLineState(seed: number, units: UnitState[]): GameState {
    return {
      seed,
      tick: 0,
      config: createConfig({ baseSpeed: 0.3, territoryMoveBonus: 0 }),
      nodes: [0, 1, 2, 3].map((q) => ({ q, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null })),
      neighbors: [[1], [0, 2], [1, 3], [2]],
      teams: [
        { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
        { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
      ],
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

  /** A diamond: 0(start) branches to 1 and 2, both of which lead to 3(goal). Lets tests force a
   * reroute by blocking one of the two routes. */
  function makeDiamondState(seed: number, units: UnitState[]): GameState {
    return {
      seed,
      tick: 0,
      config: createConfig({ baseSpeed: 0.3 }),
      nodes: [
        { q: 0, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null },
        { q: 1, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null },
        { q: 0, r: 1, elevation: 0.5, passable: true, owner: null, captureProgress: null },
        { q: 1, r: 1, elevation: 0.5, passable: true, owner: null, captureProgress: null },
      ],
      neighbors: [
        [1, 2],
        [0, 3],
        [0, 3],
        [1, 2],
      ],
      teams: [{ id: 0, alive: true, eliminatedAtTick: null, killCount: 0 }],
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

  it('two units racing for the same node: the earlier-ordered unit claims it, the other is blocked and stays put', () => {
    // Both want node 1 (the only node adjacent to both 0 and 2 on this line): unit 0 from node 0,
    // unit 1 from node 2. Processing order is (teamId,unitId) ascending, so unit 0 wins.
    const unitA = makeUnit(0, 0)
    unitA.command = { type: 'moveTo', node: 1 }
    const unitB = makeUnit(1, 2)
    unitB.command = { type: 'moveTo', node: 1 }
    const state = makeMultiUnitLineState(1, [unitA, unitB])

    tickAll(state)

    expect(unitA.pos.to).toBe(1) // won the race
    expect(unitB.pos).toEqual({ from: 2, to: 2, progress: 0 }) // blocked: node 1 is its destination itself, no alternate route
  })

  it('even teammates cannot share a node (not just enemies)', () => {
    const unitA = makeUnit(0, 0)
    unitA.teamId = 0
    unitA.command = { type: 'moveTo', node: 1 }
    const unitB = makeUnit(1, 2)
    unitB.teamId = 0 // same team as unitA
    unitB.command = { type: 'moveTo', node: 1 }
    const state = makeMultiUnitLineState(1, [unitA, unitB])

    tickAll(state)

    expect(unitA.pos.to).toBe(1)
    expect(unitB.pos).toEqual({ from: 2, to: 2, progress: 0 })
  })

  it('reroutes around a stationary blocker when an alternate route exists', () => {
    const blocker = makeUnit(0, 1) // sits on the direct route, never moves (idle)
    const mover = makeUnit(1, 0)
    mover.command = { type: 'moveTo', node: 3 }
    const state = makeDiamondState(1, [blocker, mover])

    tickAll(state)

    // Blocker never moves; mover must route via node 2 instead of the occupied node 1.
    expect(blocker.pos).toEqual({ from: 1, to: 1, progress: 0 })
    expect(mover.pos.to).toBe(2)
  })

  it('waits (does not move) when the only route to the destination is occupied', () => {
    const blocker = makeUnit(0, 1)
    const mover = makeUnit(1, 0)
    mover.command = { type: 'moveTo', node: 1 } // node 1 is the destination itself, and it's occupied
    const state = makeDiamondState(1, [blocker, mover])

    tickAll(state)

    expect(mover.pos).toEqual({ from: 0, to: 0, progress: 0 })
  })

  it('stops cleanly at the last successfully-claimed node when an overshoot hop is blocked mid-tick', () => {
    // unit 0 (processed first) simply rests at node 2 for the whole test.
    const blocker = makeUnit(0, 2)
    // unit 1 (processed second) is already mid-edge 0->1 with enough leftover progress that this
    // tick's overshoot would normally continue straight through node 2.
    const mover = makeUnit(1, 1)
    mover.pos = { from: 0, to: 1, progress: 0.9 }
    mover.destination = 3
    mover.path = [2, 3]
    mover.command = { type: 'moveTo', node: 3 }
    const state = makeMultiUnitLineState(1, [blocker, mover])

    tickAll(state)

    expect(blocker.pos).toEqual({ from: 2, to: 2, progress: 0 })
    // Arrives at 1 (from the overshoot) but is blocked from continuing into the occupied node 2,
    // so it stops there rather than "returning" anywhere — it never committed to entering node 2.
    expect(mover.pos).toEqual({ from: 1, to: 1, progress: 0 })
    expect(mover.path).toBeNull() // cleared so next tick re-searches fresh
  })

  it('never lets two alive units share a pos.to across many ticks of contested movement', () => {
    const units = [
      makeUnit(0, 0),
      makeUnit(1, 1),
      makeUnit(2, 2),
      makeUnit(3, 3),
    ]
    // Send everyone toward the same far corner to force sustained contention.
    for (const u of units) u.command = { type: 'moveTo', node: 0 }
    const state = makeMultiUnitLineState(1, units)

    for (let i = 0; i < 30; i++) {
      tickAll(state)
      const toValues = state.units.filter((u) => u.alive).map((u) => u.pos.to)
      expect(new Set(toValues).size).toBe(toValues.length)
    }
  })
})
