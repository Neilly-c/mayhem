import { describe, expect, it } from 'vitest'
import * as tf from '@tensorflow/tfjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ActorCriticModel, MOVE_ACTIONS } from '../network'

describe('ActorCriticModel', () => {
  it('produces correctly-shaped move/attack/value outputs for a given config and batch size', () => {
    const model = ActorCriticModel.build({ obsDim: 12, maxVisibleEnemies: 4, hiddenSizes: [8, 8] })
    const obs = tf.randomNormal([5, 12]) as tf.Tensor2D
    const { moveLogits, attackLogits, value } = model.forward(obs)

    expect(moveLogits.shape).toEqual([5, MOVE_ACTIONS])
    expect(attackLogits.shape).toEqual([5, 5]) // maxVisibleEnemies+1
    expect(value.shape).toEqual([5, 1])

    tf.dispose([obs, moveLogits, attackLogits, value])
  })

  it('builds successfully with the default hidden-layer sizes when hiddenSizes is omitted', () => {
    const model = ActorCriticModel.build({ obsDim: 6, maxVisibleEnemies: 2 })
    const obs = tf.randomNormal([1, 6]) as tf.Tensor2D
    const { moveLogits, attackLogits, value } = model.forward(obs)

    expect(moveLogits.shape).toEqual([1, MOVE_ACTIONS])
    expect(attackLogits.shape).toEqual([1, 3])
    expect(value.shape).toEqual([1, 1])

    tf.dispose([obs, moveLogits, attackLogits, value])
  })

  it('save/load round-trip preserves forward-pass output exactly', async () => {
    const model = ActorCriticModel.build({ obsDim: 10, maxVisibleEnemies: 3, hiddenSizes: [16] })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-network-test-'))
    try {
      await model.save(dir)
      expect(fs.existsSync(path.join(dir, 'model.json'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'weights.bin'))).toBe(true)

      const loaded = await ActorCriticModel.load(dir, model.config)

      const obs = tf.randomNormal([3, 10]) as tf.Tensor2D
      const before = model.forward(obs)
      const after = loaded.forward(obs)

      expect(await after.moveLogits.array()).toEqual(await before.moveLogits.array())
      expect(await after.attackLogits.array()).toEqual(await before.attackLogits.array())
      expect(await after.value.array()).toEqual(await before.value.array())

      tf.dispose([obs, before.moveLogits, before.attackLogits, before.value, after.moveLogits, after.attackLogits, after.value])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loaded model config reflects what the caller passed to load()', async () => {
    const model = ActorCriticModel.build({ obsDim: 5, maxVisibleEnemies: 1 })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-network-test-'))
    try {
      await model.save(dir)
      const loaded = await ActorCriticModel.load(dir, { obsDim: 5, maxVisibleEnemies: 1, hiddenSizes: [64] })
      expect(loaded.config).toEqual({ obsDim: 5, maxVisibleEnemies: 1, hiddenSizes: [64] })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
