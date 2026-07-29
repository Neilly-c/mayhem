import { describe, expect, it } from 'vitest'
import { Env } from '../../env'
import { ActorCriticModel, MOVE_ACTIONS } from '../network'
import { collectRollout, createRolloutState } from '../rolloutBuffer'
import { inferObsDim } from '../shapes'

const SIM_CONFIG = {
  mapRadius: 4,
  wallThreshold: 0,
  teamCount: 2,
  unitsPerTeam: 1,
  maxVisibleEnemies: 2,
  decisionInterval: 2,
}

function isFinite(n: number): boolean {
  return Number.isFinite(n)
}

describe('collectRollout', () => {
  it('produces a well-formed batch: correctly-shaped steps with finite values, no NaNs', () => {
    const numEnvs = 2
    const envs = Array.from({ length: numEnvs }, () => Env.create(1, { simConfig: SIM_CONFIG }))
    const obsDim = inferObsDim(SIM_CONFIG, 1)
    const model = ActorCriticModel.build({ obsDim, maxVisibleEnemies: SIM_CONFIG.maxVisibleEnemies, hiddenSizes: [8] })
    const rolloutState = createRolloutState(envs, 42)

    const batch = collectRollout(rolloutState, model, { rolloutLength: 6, gamma: 0.99, lambda: 0.95, baseSeed: 42 })

    expect(batch.steps.length).toBeGreaterThan(0)
    for (const step of batch.steps) {
      expect(step.obs).toHaveLength(obsDim)
      expect(step.moveMask).toHaveLength(MOVE_ACTIONS)
      expect(step.attackMask).toHaveLength(SIM_CONFIG.maxVisibleEnemies + 1)
      expect(step.moveMask[0]).toBe(true) // idle is always legal
      expect(step.moveAction).toBeGreaterThanOrEqual(0)
      expect(step.moveAction).toBeLessThan(MOVE_ACTIONS)
      expect(step.attackAction).toBeGreaterThanOrEqual(0)
      expect(step.attackAction).toBeLessThanOrEqual(SIM_CONFIG.maxVisibleEnemies)
      expect(isFinite(step.oldLogProb)).toBe(true)
      expect(isFinite(step.value)).toBe(true)
      expect(isFinite(step.advantage)).toBe(true)
      expect(isFinite(step.return)).toBe(true)
    }
  })

  it('auto-resets an env once maxTicks truncates it, keeping collection continuous and recording an episode return', () => {
    const envs = [Env.create(2, { simConfig: SIM_CONFIG, maxTicks: 6 })] // decisionInterval:2 -> truncates on the 3rd step()
    const obsDim = inferObsDim(SIM_CONFIG, 2)
    const model = ActorCriticModel.build({ obsDim, maxVisibleEnemies: SIM_CONFIG.maxVisibleEnemies, hiddenSizes: [8] })
    const rolloutState = createRolloutState(envs, 7)

    const batch = collectRollout(rolloutState, model, { rolloutLength: 10, gamma: 0.99, lambda: 0.95, baseSeed: 7 })

    // At least one full episode (bounded by maxTicks) must have completed and reset within the window.
    expect(rolloutState.episodeIds[0]).toBeGreaterThan(0)
    expect(batch.episodeReturns.length).toBeGreaterThan(0)
    for (const ret of batch.episodeReturns) expect(isFinite(ret)).toBe(true)
    // Collection kept going past the reset (didn't stall).
    expect(batch.steps.length).toBeGreaterThan(3)
  })

  it('persists rollout state across repeated calls (continues envs instead of restarting them each time)', () => {
    const envs = [Env.create(3, { simConfig: SIM_CONFIG })]
    const obsDim = inferObsDim(SIM_CONFIG, 3)
    const model = ActorCriticModel.build({ obsDim, maxVisibleEnemies: SIM_CONFIG.maxVisibleEnemies, hiddenSizes: [8] })
    const rolloutState = createRolloutState(envs, 5)

    collectRollout(rolloutState, model, { rolloutLength: 3, gamma: 0.99, lambda: 0.95, baseSeed: 5 })
    const tickAfterFirstCall = envs[0].state.tick
    expect(tickAfterFirstCall).toBeGreaterThan(0)

    collectRollout(rolloutState, model, { rolloutLength: 3, gamma: 0.99, lambda: 0.95, baseSeed: 5 })
    expect(envs[0].state.tick).toBeGreaterThan(tickAfterFirstCall)
  })
})
