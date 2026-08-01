import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import { generateMap } from '../mapgen'
import { world } from '../hexgrid'
import { applySlipDamage, initRingState, tickRing } from '../ring'
import type { GameState, UnitState } from '../types'

// wallThreshold: 0 guarantees every generated node is passable (elevation is always >= 0),
// so the ring tests get a fully-connected, wall-free hex disk without fighting map RNG.
function smallRingConfig(overrides?: Partial<GameState['config']>) {
  return createConfig({
    mapRadius: 6,
    wallThreshold: 0,
    ringRadiusSchedule: [6, 4, 2, 0],
    warnTicks: 3,
    shrinkTicks: 4,
    slipDamage: [1, 2, 4],
    ...overrides,
  })
}

function makeRingGameState(config: ReturnType<typeof smallRingConfig>, seed = 1): GameState {
  const { nodes, neighbors } = generateMap(seed, config)
  return {
    seed,
    tick: 0,
    config,
    nodes,
    neighbors,
    teams: [{ id: 0, alive: true, eliminatedAtTick: null, killCount: 0 }],
    units: [],
    ring: initRingState(seed, config, nodes),
    projectiles: [],
    nextProjectileId: 0,
    laserBeams: [],
    nextLaserBeamId: 0,
  }
}

function makeUnitAt(id: number, nodeIdx: number): UnitState {
  return {
    id,
    teamId: 0,
    pos: { from: nodeIdx, to: nodeIdx, progress: 0 },
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

describe('ring: initialization', () => {
  it('starts at stage 0/warn, centered on the map origin, with the full map-radius as the safe radius', () => {
    const config = smallRingConfig()
    const { nodes } = generateMap(1, config)
    const ring = initRingState(1, config, nodes)

    expect(ring.stage).toBe(0)
    expect(ring.phase).toBe('warn')
    expect(ring.activeRadius).toBe(config.ringRadiusSchedule[0])
    expect(ring.centerWorld).toEqual({ x: 0, y: 0 }) // world(q=0,r=0)
    expect(ring.shrinkStartCenter).toEqual(ring.centerWorld)
    expect(ring.nextRadius).toBe(config.ringRadiusSchedule[1])
    expect(nodes[ring.nextCenter].passable).toBe(true)
  })

  it('is deterministic for a given seed', () => {
    const config = smallRingConfig()
    const { nodes } = generateMap(42, config)
    const a = initRingState(42, config, nodes)
    const b = initRingState(42, config, nodes)
    expect(a).toEqual(b)
  })
})

describe('ring: stage machine', () => {
  it('stays in warn (constant center/radius) until warnTicks elapses, then enters shrink without having moved yet', () => {
    const config = smallRingConfig()
    const state = makeRingGameState(config)
    const originalCenterWorld = state.ring.centerWorld
    const plannedNextCenter = state.ring.nextCenter

    for (let i = 0; i < config.warnTicks - 1; i++) {
      tickRing(state)
      expect(state.ring.phase).toBe('warn')
      expect(state.ring.activeRadius).toBe(config.ringRadiusSchedule[0])
      expect(state.ring.centerWorld).toEqual(originalCenterWorld)
    }

    tickRing(state) // exactly warnTicks ticks elapsed
    expect(state.ring.phase).toBe('shrink')
    expect(state.ring.phaseTicks).toBe(0)
    expect(state.ring.nextCenter).toBe(plannedNextCenter)
    // The center hasn't started moving on the transition tick itself; it's the lerp start point.
    expect(state.ring.centerWorld).toEqual(originalCenterWorld)
    expect(state.ring.shrinkStartCenter).toEqual(originalCenterWorld)
    expect(state.ring.activeRadius).toBe(config.ringRadiusSchedule[0])
  })

  it('moves the center via constant-velocity linear motion from the previous ring toward the new one, in lockstep with the radius', () => {
    const config = smallRingConfig()
    const state = makeRingGameState(config)
    for (let i = 0; i < config.warnTicks; i++) tickRing(state)
    expect(state.ring.phase).toBe('shrink')

    const shrinkStartCenter = state.ring.shrinkStartCenter
    const targetCenter = world(state.nodes[state.ring.nextCenter])
    const [r0, r1] = config.ringRadiusSchedule

    for (let i = 1; i <= config.shrinkTicks; i++) {
      tickRing(state)
      const t = i / config.shrinkTicks
      if (i < config.shrinkTicks) {
        expect(state.ring.activeRadius).toBeCloseTo(r0 + (r1 - r0) * t, 10)
        expect(state.ring.centerWorld.x).toBeCloseTo(
          shrinkStartCenter.x + (targetCenter.x - shrinkStartCenter.x) * t,
          10,
        )
        expect(state.ring.centerWorld.y).toBeCloseTo(
          shrinkStartCenter.y + (targetCenter.y - shrinkStartCenter.y) * t,
          10,
        )
      }
    }

    expect(state.ring.activeRadius).toBe(r1)
    expect(state.ring.centerWorld).toEqual(targetCenter)
    expect(state.ring.stage).toBe(1)
    expect(state.ring.phase).toBe('warn')
    expect(state.nodes[state.ring.nextCenter].passable).toBe(true)
  })

  it('reaches "done" with radius 0 after the final stage, and every chosen center was passable', () => {
    const config = smallRingConfig()
    const state = makeRingGameState(config)
    const stageCount = config.ringRadiusSchedule.length - 1

    for (let i = 0; i < (config.warnTicks + config.shrinkTicks) * stageCount + 5; i++) {
      tickRing(state)
      expect(state.nodes[state.ring.nextCenter].passable).toBe(true)
    }

    expect(state.ring.phase).toBe('done')
    expect(state.ring.activeRadius).toBe(0)
    expect(state.ring.stage).toBe(stageCount)
  })
})

describe('ring: monotonic containment', () => {
  it('never lets the safe zone re-include area that was previously outside it, at every tick of every stage', () => {
    // Checks dist(prevCenter, newCenter) + newRadius <= prevRadius (+ epsilon) every single tick,
    // not just at stage boundaries — this holds continuously through the shrink interpolation too.
    for (const seed of [1, 2, 3, 42]) {
      const config = smallRingConfig()
      const state = makeRingGameState(config, seed)
      const stageCount = config.ringRadiusSchedule.length - 1

      let prevCenter = state.ring.centerWorld
      let prevRadius = state.ring.activeRadius

      for (let i = 0; i < (config.warnTicks + config.shrinkTicks) * stageCount + 5; i++) {
        tickRing(state)
        const drift = Math.hypot(
          state.ring.centerWorld.x - prevCenter.x,
          state.ring.centerWorld.y - prevCenter.y,
        )
        expect(drift + state.ring.activeRadius).toBeLessThanOrEqual(prevRadius + 1e-9)
        prevCenter = state.ring.centerWorld
        prevRadius = state.ring.activeRadius
      }

      expect(state.ring.phase).toBe('done')
    }
  })
})

describe('ring: fixed radius schedule, randomized center', () => {
  it('uses the exact configured radii for every seed, never altering them', () => {
    const config = smallRingConfig()
    for (const seed of [1, 2, 3, 42]) {
      const { nodes } = generateMap(seed, config)
      const ring = initRingState(seed, config, nodes)
      expect(ring.activeRadius).toBe(config.ringRadiusSchedule[0])
      expect(ring.nextRadius).toBe(config.ringRadiusSchedule[1])
    }
  })

  it('picks different center trajectories for different seeds despite the identical radius schedule', () => {
    const config = smallRingConfig()
    const centersBySeed = [1, 2, 3].map((seed) => {
      const state = makeRingGameState(config, seed)
      for (let i = 0; i < config.warnTicks + config.shrinkTicks; i++) tickRing(state)
      return state.ring.centerWorld
    })
    const allSame = centersBySeed.every(
      (c) => c.x === centersBySeed[0].x && c.y === centersBySeed[0].y,
    )
    expect(allSame).toBe(false)
  })
})

describe('ring: slip damage', () => {
  it('damages units outside the active radius and spares units inside it', () => {
    const config = smallRingConfig()
    const state = makeRingGameState(config)
    const originIdx = state.nodes.findIndex((n) => n.q === 0 && n.r === 0)
    const farIdx = state.nodes.findIndex((n) => n.q === 6 && n.r === 0) // world dist 6.0 from origin
    const originWorld = world(state.nodes[originIdx])

    state.ring = {
      stage: 0,
      phase: 'warn',
      phaseTicks: 0,
      centerWorld: originWorld,
      activeRadius: 2.0,
      shrinkStartCenter: originWorld,
      nextCenter: originIdx,
      nextRadius: 2.0,
    }
    state.units = [makeUnitAt(0, originIdx), makeUnitAt(1, farIdx)]
    expect(world(state.nodes[farIdx]).x).toBeGreaterThan(2.0)

    const events = applySlipDamage(state)

    expect(state.units[0].hp).toBe(100) // inside safe radius
    expect(state.units[1].hp).toBe(100 - config.slipDamage[0]) // outside
    expect(events).toEqual([{ unitId: 1, damage: config.slipDamage[0] }])
  })

  it('uses the last slipDamage entry once the ring reaches "done"', () => {
    const config = smallRingConfig()
    const state = makeRingGameState(config)
    const originIdx = state.nodes.findIndex((n) => n.q === 0 && n.r === 0)
    const farIdx = state.nodes.findIndex((n) => n.q === 6 && n.r === 0)
    const originWorld = world(state.nodes[originIdx])

    state.ring = {
      stage: config.ringRadiusSchedule.length - 1,
      phase: 'done',
      phaseTicks: 0,
      centerWorld: originWorld,
      activeRadius: 0,
      shrinkStartCenter: originWorld,
      nextCenter: originIdx,
      nextRadius: 0,
    }
    state.units = [makeUnitAt(1, farIdx)]

    applySlipDamage(state)

    expect(state.units[0].hp).toBe(100 - config.slipDamage[config.slipDamage.length - 1])
  })

  it('increases continuously with round progress rather than jumping only at stage boundaries', () => {
    const config = smallRingConfig() // warnTicks:3, shrinkTicks:4, slipDamage:[1,2,4]
    const state = makeRingGameState(config)
    const originIdx = state.nodes.findIndex((n) => n.q === 0 && n.r === 0)
    const farIdx = state.nodes.findIndex((n) => n.q === 6 && n.r === 0)
    const originWorld = world(state.nodes[originIdx])
    state.units = [makeUnitAt(0, farIdx)]

    const totalStageTicks = config.warnTicks + config.shrinkTicks // 7

    // Partway through the warn phase of stage 0: interpolates toward slipDamage[1].
    state.ring = {
      stage: 0,
      phase: 'warn',
      phaseTicks: 1,
      centerWorld: originWorld,
      activeRadius: 2.0,
      shrinkStartCenter: originWorld,
      nextCenter: originIdx,
      nextRadius: 2.0,
    }
    state.units[0].hp = 100
    applySlipDamage(state)
    const expectedWarnDamage = config.slipDamage[0] + (config.slipDamage[1] - config.slipDamage[0]) * (1 / totalStageTicks)
    expect(state.units[0].hp).toBeCloseTo(100 - expectedWarnDamage, 10)
    expect(expectedWarnDamage).toBeGreaterThan(config.slipDamage[0])
    expect(expectedWarnDamage).toBeLessThan(config.slipDamage[1])

    // Partway through the shrink phase of stage 0: further along than the warn-phase sample above.
    state.ring.phase = 'shrink'
    state.ring.phaseTicks = 2
    state.units[0].hp = 100
    applySlipDamage(state)
    const expectedShrinkDamage =
      config.slipDamage[0] + (config.slipDamage[1] - config.slipDamage[0]) * ((config.warnTicks + 2) / totalStageTicks)
    expect(state.units[0].hp).toBeCloseTo(100 - expectedShrinkDamage, 10)
    expect(expectedShrinkDamage).toBeGreaterThan(expectedWarnDamage)
  })

  it('does not damage dead units', () => {
    const config = smallRingConfig()
    const state = makeRingGameState(config)
    const farIdx = state.nodes.findIndex((n) => n.q === 6 && n.r === 0)
    state.ring.activeRadius = 0
    state.units = [{ ...makeUnitAt(0, farIdx), alive: false }]

    applySlipDamage(state)

    expect(state.units[0].hp).toBe(100)
  })
})
