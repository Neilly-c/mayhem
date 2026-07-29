import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tf from '@tensorflow/tfjs'
import { defaultConfig } from '../../sim'
import { ActorCriticModel } from '../network'
import { loadCheckpoint, saveCheckpoint } from '../checkpoint'
import type { CheckpointMeta } from '../types'

describe('checkpoint save/load', () => {
  it('round-trips the model and the meta.json sidecar (config not carried by model.json)', async () => {
    const networkConfig = { obsDim: 7, maxVisibleEnemies: 2, hiddenSizes: [8] }
    const model = ActorCriticModel.build(networkConfig)
    const meta: CheckpointMeta = {
      iteration: 42,
      networkConfig,
      simConfig: defaultConfig(),
      createdAt: new Date().toISOString(),
      score: 0.6,
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-checkpoint-test-'))
    try {
      await saveCheckpoint(model, dir, meta)
      expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true)

      const loaded = await loadCheckpoint(dir)
      expect(loaded.meta).toEqual(meta)
      expect(loaded.model.config).toEqual(networkConfig)

      const obs = tf.randomNormal([2, networkConfig.obsDim]) as tf.Tensor2D
      const before = model.forward(obs)
      const after = loaded.model.forward(obs)
      expect(await after.value.array()).toEqual(await before.value.array())

      tf.dispose([obs, before.moveLogits, before.attackLogits, before.value, after.moveLogits, after.attackLogits, after.value])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
