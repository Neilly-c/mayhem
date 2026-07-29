import { describe, expect, it } from 'vitest'
import { computeGAE } from '../gae'

describe('computeGAE', () => {
  it('matches a hand-computed 2-step example when not terminal (uses bootstrapValue)', () => {
    const result = computeGAE(
      { rewards: [1, 2], values: [0.5, 0.6], bootstrapValue: 0.7, terminal: false },
      0.9,
      0.95,
    )
    // t=1: delta = 2 + 0.9*0.7 - 0.6 = 2.03; gae = 2.03
    // t=0: delta = 1 + 0.9*0.6 - 0.5 = 1.04; gae = 1.04 + 0.9*0.95*2.03 = 2.77565
    expect(result.advantages[1]).toBeCloseTo(2.03, 10)
    expect(result.returns[1]).toBeCloseTo(2.63, 10)
    expect(result.advantages[0]).toBeCloseTo(2.77565, 10)
    expect(result.returns[0]).toBeCloseTo(3.27565, 10)
  })

  it('ignores bootstrapValue and uses 0 for the final value when terminal (real death)', () => {
    const result = computeGAE(
      { rewards: [1, 2], values: [0.5, 0.6], bootstrapValue: 0.7, terminal: true },
      0.9,
      0.95,
    )
    // t=1: delta = 2 + 0.9*0 - 0.6 = 1.4; gae = 1.4
    // t=0: delta = 1 + 0.9*0.6 - 0.5 = 1.04; gae = 1.04 + 0.9*0.95*1.4 = 2.237
    expect(result.advantages[1]).toBeCloseTo(1.4, 10)
    expect(result.returns[1]).toBeCloseTo(2.0, 10)
    expect(result.advantages[0]).toBeCloseTo(2.237, 10)
    expect(result.returns[0]).toBeCloseTo(2.737, 10)
  })

  it('produces a strictly higher advantage/return for the same rewards when not terminal vs terminal', () => {
    const notTerminal = computeGAE(
      { rewards: [1, 2], values: [0.5, 0.6], bootstrapValue: 0.7, terminal: false },
      0.9,
      0.95,
    )
    const terminal = computeGAE(
      { rewards: [1, 2], values: [0.5, 0.6], bootstrapValue: 0.7, terminal: true },
      0.9,
      0.95,
    )
    expect(notTerminal.advantages[0]).toBeGreaterThan(terminal.advantages[0])
  })

  it('returns empty arrays for a zero-length segment', () => {
    const result = computeGAE({ rewards: [], values: [], bootstrapValue: 0, terminal: false }, 0.9, 0.95)
    expect(result.advantages).toEqual([])
    expect(result.returns).toEqual([])
  })

  it('reduces to a single TD-residual for a 1-step segment', () => {
    const result = computeGAE({ rewards: [3], values: [1], bootstrapValue: 2, terminal: false }, 0.5, 0.8)
    // delta = 3 + 0.5*2 - 1 = 3.0; gae = delta (no recursion at T=1)
    expect(result.advantages[0]).toBeCloseTo(3.0, 10)
    expect(result.returns[0]).toBeCloseTo(4.0, 10)
  })
})
