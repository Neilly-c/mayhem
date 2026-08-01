import { describe, expect, it } from 'vitest'
import * as tf from '@tensorflow/tfjs'
import { deriveRng } from '../../sim'
import { ActorCriticModel } from '../network'
import { runPpoUpdate } from '../ppo'
import type { PPOConfig, RolloutBatch, RolloutStep } from '../types'

const OBS_DIM = 6
const MAX_VISIBLE_ENEMIES = 2 // attack head size = 3

function makeSyntheticBatch(n: number, seed = 1): RolloutBatch {
  const rng = deriveRng(seed, 'ppo-test-batch')
  const steps: RolloutStep[] = []
  for (let i = 0; i < n; i++) {
    steps.push({
      obs: Array.from({ length: OBS_DIM }, () => rng() * 2 - 1),
      moveMask: [true, true, true, true, true, true, true],
      attackMask: [true, true, true],
      abilityMask: [true, true, true, true, true, true, true],
      moveAction: Math.floor(rng() * 7),
      attackAction: Math.floor(rng() * 3),
      abilityAction: Math.floor(rng() * 7),
      oldLogProb: -1.5 - rng(),
      value: rng() * 2 - 1,
      advantage: rng() * 2 - 1,
      return: rng() * 2 - 1,
    })
  }
  return { steps, episodeReturns: [] }
}

function defaultTestPPOConfig(): PPOConfig {
  return {
    clipRatio: 0.2,
    epochs: 2,
    minibatchSize: 8,
    valueLossCoef: 0.5,
    entropyCoef: 0.01,
    learningRate: 1e-3,
  }
}

describe('runPpoUpdate', () => {
  it('produces finite, non-NaN loss stats on a synthetic batch', () => {
    const model = ActorCriticModel.build({ obsDim: OBS_DIM, maxVisibleEnemies: MAX_VISIBLE_ENEMIES, hiddenSizes: [8] })
    const optimizer = tf.train.adam(defaultTestPPOConfig().learningRate)
    const batch = makeSyntheticBatch(20)
    const rng = deriveRng(1, 'ppo-test-shuffle')

    const stats = runPpoUpdate(model, optimizer, batch, defaultTestPPOConfig(), rng)

    for (const [key, val] of Object.entries(stats)) {
      expect(Number.isFinite(val), `${key} should be finite, got ${val}`).toBe(true)
    }
    optimizer.dispose()
  })

  it('returns zeroed stats for an empty batch without crashing', () => {
    const model = ActorCriticModel.build({ obsDim: OBS_DIM, maxVisibleEnemies: MAX_VISIBLE_ENEMIES, hiddenSizes: [8] })
    const optimizer = tf.train.adam(1e-3)
    const rng = deriveRng(1, 'ppo-test-empty')

    const stats = runPpoUpdate(model, optimizer, { steps: [], episodeReturns: [] }, defaultTestPPOConfig(), rng)

    expect(stats).toEqual({ policyLoss: 0, valueLoss: 0, entropy: 0, approxKl: 0, clipFraction: 0 })
    optimizer.dispose()
  })

  it('does not leak tensors: tf.memory().numTensors stabilizes across repeated updates', () => {
    const model = ActorCriticModel.build({ obsDim: OBS_DIM, maxVisibleEnemies: MAX_VISIBLE_ENEMIES, hiddenSizes: [8] })
    const optimizer = tf.train.adam(1e-3)
    const batch = makeSyntheticBatch(20)
    const config = defaultTestPPOConfig()

    // First call may create persistent optimizer state (Adam momentum/velocity buffers);
    // only compare counts from the second call onward.
    runPpoUpdate(model, optimizer, batch, config, deriveRng(1, 'ppo-test-leak-0'))
    const afterFirst = tf.memory().numTensors

    for (let i = 1; i <= 4; i++) {
      runPpoUpdate(model, optimizer, batch, config, deriveRng(1, `ppo-test-leak-${i}`))
    }
    const afterRepeated = tf.memory().numTensors

    expect(afterRepeated).toBe(afterFirst)
    optimizer.dispose()
  })

  it('respects clipValueLoss:false (falls back to plain MSE) without crashing', () => {
    const model = ActorCriticModel.build({ obsDim: OBS_DIM, maxVisibleEnemies: MAX_VISIBLE_ENEMIES, hiddenSizes: [8] })
    const optimizer = tf.train.adam(1e-3)
    const batch = makeSyntheticBatch(10)
    const config: PPOConfig = { ...defaultTestPPOConfig(), clipValueLoss: false }

    const stats = runPpoUpdate(model, optimizer, batch, config, deriveRng(1, 'ppo-test-unclipped'))
    expect(Number.isFinite(stats.valueLoss)).toBe(true)
    optimizer.dispose()
  })
})
