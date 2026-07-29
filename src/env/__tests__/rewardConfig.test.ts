import { describe, expect, it } from 'vitest'
import { createRewardConfig } from '../rewardConfig'

describe('defaultRankBonus (via createRewardConfig)', () => {
  it('returns exactly one bonus per team, strictly decreasing from 1st to last place', () => {
    const config = createRewardConfig(4)
    expect(config.rankBonus).toHaveLength(4)
    for (let i = 1; i < config.rankBonus.length; i++) {
      expect(config.rankBonus[i]).toBeLessThan(config.rankBonus[i - 1])
    }
  })

  it('spaces ranks with a steeper (convex) gradient toward the top than a linear curve would', () => {
    const config = createRewardConfig(4)
    const [first, second, third, fourth] = config.rankBonus
    const gapTopToSecond = first - second
    const gapSecondToThird = second - third
    const gapThirdToFourth = third - fourth
    // Convex/geometric decay: the gap shrinks going down the ranking, unlike a linear curve
    // where every adjacent gap is equal.
    expect(gapTopToSecond).toBeGreaterThan(gapSecondToThird)
    expect(gapSecondToThird).toBeGreaterThan(gapThirdToFourth)
  })

  it('makes 1st place dominate the sum of all other rank bonuses combined', () => {
    // ユーザー要望: 全チームとも優勝(1位)を最優先するような報酬配分にする。
    const config = createRewardConfig(6)
    const [first, ...rest] = config.rankBonus
    const restSum = rest.reduce((a, b) => a + b, 0)
    expect(first).toBeGreaterThan(restSum)
  })

  it('returns just the max bonus for a single-team config', () => {
    const config = createRewardConfig(1)
    expect(config.rankBonus).toHaveLength(1)
    expect(config.rankBonus[0]).toBeGreaterThan(0)
  })

  it('is deterministic and independent of teamCount for the top-rank bonus value', () => {
    expect(createRewardConfig(2).rankBonus[0]).toBe(createRewardConfig(6).rankBonus[0])
  })
})
