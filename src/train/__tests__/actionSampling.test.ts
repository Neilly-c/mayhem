import { describe, expect, it } from 'vitest'
import * as tf from '@tensorflow/tfjs'
import { argmaxMaskedCategorical, evaluateMaskedCategorical, sampleMaskedCategorical } from '../actionSampling'

/** Independent reference implementation (plain JS, no tf) to cross-check against. */
function softmaxProbs(xs: number[]): number[] {
  const max = Math.max(...xs)
  const exps = xs.map((x) => Math.exp(x - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sum)
}

function softmaxEntropy(xs: number[]): number {
  const probs = softmaxProbs(xs)
  return -probs.reduce((acc, p) => acc + (p > 0 ? p * Math.log(p) : 0), 0)
}

describe('actionSampling', () => {
  it('never samples a masked-out action, even one with a huge logit', () => {
    const logits = tf.tensor2d([[1, 2, 3, 100]])
    const mask = tf.tensor2d([[1, 1, 1, 0]])

    for (let i = 0; i < 200; i++) {
      const { actions, logProbs, entropy } = sampleMaskedCategorical(logits, mask, i)
      const action = actions.dataSync()[0]
      expect(action).not.toBe(3)
      expect(Number.isNaN(logProbs.dataSync()[0])).toBe(false)
      expect(Number.isNaN(entropy.dataSync()[0])).toBe(false)
      tf.dispose([actions, logProbs, entropy])
    }
    tf.dispose([logits, mask])
  })

  it('computes logProb/entropy as if the masked action did not exist at all', () => {
    const logits = tf.tensor2d([[1, 2, 3, 100]])
    const mask = tf.tensor2d([[1, 1, 1, 0]])
    const expectedProbs = softmaxProbs([1, 2, 3])
    const expectedEntropy = softmaxEntropy([1, 2, 3])

    for (let action = 0; action < 3; action++) {
      const actions = tf.tensor1d([action], 'int32')
      const { logProbs, entropy } = evaluateMaskedCategorical(logits, mask, actions)
      expect(logProbs.dataSync()[0]).toBeCloseTo(Math.log(expectedProbs[action]), 5)
      expect(entropy.dataSync()[0]).toBeCloseTo(expectedEntropy, 5)
      tf.dispose([actions, logProbs, entropy])
    }
    tf.dispose([logits, mask])
  })

  it('gives the masked-out action ~0 probability (very negative log-prob), not NaN', () => {
    const logits = tf.tensor2d([[1, 2, 3, 100]])
    const mask = tf.tensor2d([[1, 1, 1, 0]])
    const actions = tf.tensor1d([3], 'int32') // force-evaluate the masked action

    const { logProbs, entropy } = evaluateMaskedCategorical(logits, mask, actions)
    expect(Number.isNaN(logProbs.dataSync()[0])).toBe(false)
    expect(Number.isNaN(entropy.dataSync()[0])).toBe(false)
    expect(logProbs.dataSync()[0]).toBeLessThan(-1000)

    tf.dispose([logits, mask, actions, logProbs, entropy])
  })

  it('gives exactly zero entropy and zero log-prob when only one action is legal', () => {
    const logits = tf.tensor2d([[5, -3, 10]])
    const mask = tf.tensor2d([[0, 1, 0]])
    const actions = tf.tensor1d([1], 'int32')

    const { logProbs, entropy } = evaluateMaskedCategorical(logits, mask, actions)
    expect(logProbs.dataSync()[0]).toBeCloseTo(0, 5)
    expect(entropy.dataSync()[0]).toBeCloseTo(0, 5)

    tf.dispose([logits, mask, actions, logProbs, entropy])
  })

  it('sampleMaskedCategorical and evaluateMaskedCategorical agree on logProb/entropy for the same sampled action', () => {
    const logits = tf.tensor2d([[0.5, -1.2, 2.3, 0.1]])
    const mask = tf.tensor2d([[1, 0, 1, 1]])

    const sampled = sampleMaskedCategorical(logits, mask, 7)
    const evaluated = evaluateMaskedCategorical(logits, mask, sampled.actions)

    expect(evaluated.logProbs.dataSync()[0]).toBeCloseTo(sampled.logProbs.dataSync()[0], 5)
    expect(evaluated.entropy.dataSync()[0]).toBeCloseTo(sampled.entropy.dataSync()[0], 5)

    tf.dispose([logits, mask, sampled.actions, sampled.logProbs, sampled.entropy, evaluated.logProbs, evaluated.entropy])
  })

  it('argmaxMaskedCategorical always picks the legal action with the highest logit, never a masked one', () => {
    const logits = tf.tensor2d([[1, 2, 3, 100]])
    const mask = tf.tensor2d([[1, 1, 1, 0]])

    const actions = argmaxMaskedCategorical(logits, mask)
    expect(actions.dataSync()[0]).toBe(2) // index 2 (logit 3) is the best legal option; index 3 is masked despite logit 100

    tf.dispose([logits, mask, actions])
  })

  it('argmaxMaskedCategorical is deterministic across repeated calls', () => {
    const logits = tf.tensor2d([[0.1, 0.2, 0.15]])
    const mask = tf.tensor2d([[1, 1, 1]])

    const a = argmaxMaskedCategorical(logits, mask)
    const b = argmaxMaskedCategorical(logits, mask)
    expect(a.dataSync()[0]).toBe(b.dataSync()[0])

    tf.dispose([logits, mask, a, b])
  })

  it('handles a batch (multiple rows) independently', () => {
    const logits = tf.tensor2d([
      [1, 2, 3],
      [10, -10, 0],
    ])
    const mask = tf.tensor2d([
      [1, 1, 1],
      [1, 1, 0],
    ])
    const actions = tf.tensor1d([2, 0], 'int32')

    const { logProbs, entropy } = evaluateMaskedCategorical(logits, mask, actions)
    const lp = logProbs.dataSync()
    const ent = entropy.dataSync()

    expect(lp[0]).toBeCloseTo(Math.log(softmaxProbs([1, 2, 3])[2]), 5)
    expect(ent[0]).toBeCloseTo(softmaxEntropy([1, 2, 3]), 5)
    expect(lp[1]).toBeCloseTo(Math.log(softmaxProbs([10, -10])[0]), 5)
    expect(ent[1]).toBeCloseTo(softmaxEntropy([10, -10]), 5)

    tf.dispose([logits, mask, actions, logProbs, entropy])
  })
})
