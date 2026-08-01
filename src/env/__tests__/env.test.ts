import { describe, expect, it } from 'vitest'
import { Env } from '../env'
import type { ActionInput } from '../types'

const SMALL_CONFIG = { mapRadius: 8, teamCount: 2, unitsPerTeam: 2, decisionInterval: 3 }

describe('Env: reset', () => {
  it('returns an observation for every initially-alive unit, and agents reflects them all', () => {
    const env = Env.create(1, { simConfig: SMALL_CONFIG })
    const obs = env.reset(1)
    expect(env.agents).toHaveLength(4)
    expect(Object.keys(obs).map(Number).sort()).toEqual(env.agents.slice().sort((a, b) => a - b))
  })
})

describe('Env: step', () => {
  it('advances exactly decisionInterval ticks per call when nothing ends the game early', () => {
    const env = Env.create(2, { simConfig: SMALL_CONFIG })
    env.step({})
    expect(env.state.tick).toBe(3)
    env.step({})
    expect(env.state.tick).toBe(6)
  })

  it('is fully deterministic for the same seed and the same action sequence', () => {
    function run() {
      const env = Env.create(42, { simConfig: SMALL_CONFIG })
      const results = []
      for (let i = 0; i < 5; i++) {
        const actions: Record<number, ActionInput> = {}
        for (const id of env.agents) actions[id] = { move: (i + id) % 7, attack: 0, ability: 0 }
        results.push(env.step(actions))
      }
      return results
    }
    expect(run()).toEqual(run())
  })

  it('moves a unit in the commanded direction', () => {
    const env = Env.create(3, { simConfig: SMALL_CONFIG })
    const unitId = env.agents[0]
    const before = env.state.units.find((u) => u.id === unitId)!.pos.to

    // Try every direction until one actually moves the unit (some may be walls/off-map).
    let moved = false
    for (let dir = 0; dir < 6 && !moved; dir++) {
      const fresh = Env.create(3, { simConfig: SMALL_CONFIG })
      fresh.step({ [unitId]: { move: dir + 1, attack: 0, ability: 0 } })
      const after = fresh.state.units.find((u) => u.id === unitId)!.pos
      if (after.to !== before || after.from !== before) moved = true
    }
    expect(moved).toBe(true)
  })

  it('holding position (move=0) keeps a unit stationary across many decision blocks, not wandering off (regression: move=0 used to decode to idle, which sim/movement.ts treats as a random-explore fallback rather than "stay put")', () => {
    const env = Env.create(9, { simConfig: SMALL_CONFIG })
    const unitId = env.agents[0]
    const startNode = env.state.units.find((u) => u.id === unitId)!.pos.to

    for (let i = 0; i < 5; i++) {
      env.step({ [unitId]: { move: 0, attack: 0, ability: 0 } })
      const pos = env.state.units.find((u) => u.id === unitId)!.pos
      expect(pos.from).toBe(startNode)
      expect(pos.to).toBe(startNode)
    }
  })

  it('wires the attack action through to combat and reward', () => {
    const env = Env.create(4, {
      simConfig: { ...SMALL_CONFIG, visionCoreRadius: 1000, attackRange: 1000, baseDamage: 10, highGroundK: 0 },
    })
    const attacker = env.agents.find((id) => env.state.units.find((u) => u.id === id)?.teamId === 0)!
    const victim = env.state.units.find((u) => u.teamId === 1)!.id

    const obs = env.reset(4)
    const visibleEnemyIds = obs[attacker].visibleEnemyIds.filter((id) => id !== -1)
    expect(visibleEnemyIds).toContain(victim)
    const attackSlot = obs[attacker].visibleEnemyIds.indexOf(victim) + 1

    const before = env.state.units.find((u) => u.id === victim)!.hp
    const result = env.step({ [attacker]: { move: 0, attack: attackSlot, ability: 0 } })
    const after = env.state.units.find((u) => u.id === victim)!.hp

    expect(after).toBeLessThan(before)
    expect(result.rewards[attacker]).toBeGreaterThan(0)
  })

  it('drops a unit from agents/observations after it dies, and reports its termination', () => {
    const env = Env.create(5, {
      simConfig: { ...SMALL_CONFIG, visionCoreRadius: 1000, attackRange: 1000, baseDamage: 1000, highGroundK: 0 },
    })
    const attacker = env.state.units.find((u) => u.teamId === 0)!.id
    const victim = env.state.units.find((u) => u.teamId === 1)!.id

    const obs = env.reset(5)
    const attackSlot = obs[attacker].visibleEnemyIds.indexOf(victim) + 1
    expect(attackSlot).toBeGreaterThan(0) // victim must be visible for this test to be meaningful

    const result = env.step({ [attacker]: { move: 0, attack: attackSlot, ability: 0 } })

    expect(env.state.units.find((u) => u.id === victim)!.alive).toBe(false)
    expect(result.terminations[victim]).toBe(true)
    expect(env.agents).not.toContain(victim)
    const nextObs = env.step({}).observations
    expect(nextObs[victim]).toBeUndefined()
  })

  it('truncates remaining agents once maxTicks is reached', () => {
    const env = Env.create(6, { simConfig: SMALL_CONFIG, maxTicks: 3 })
    const result = env.step({})
    expect(env.state.tick).toBe(3)
    for (const id of env.agents) {
      expect(result.truncations[id]).toBe(true)
      expect(result.terminations[id]).toBe(false)
    }
  })

  it('runs independent instances without cross-contamination (vectorization sanity)', () => {
    const envA = Env.create(7, { simConfig: SMALL_CONFIG })
    const envB = Env.create(8, { simConfig: SMALL_CONFIG })
    envA.step({})
    expect(envB.state.tick).toBe(0)
    envB.step({})
    envB.step({})
    expect(envA.state.tick).toBe(3)
    expect(envB.state.tick).toBe(6)
  })
})
