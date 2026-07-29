import { describe, expect, it } from 'vitest'
import { createRewardConfig } from '../rewardConfig'

describe('defaultTerritoryRankBonus (via createRewardConfig)', () => {
  it('returns exactly one bonus per team, strictly decreasing from 1st to last place', () => {
    const config = createRewardConfig(4)
    expect(config.territoryRankBonus).toHaveLength(4)
    for (let i = 1; i < config.territoryRankBonus.length; i++) {
      expect(config.territoryRankBonus[i]).toBeLessThan(config.territoryRankBonus[i - 1])
    }
  })

  it('spaces ranks with a steeper (convex) gradient toward the top than a linear curve would', () => {
    const config = createRewardConfig(4)
    const [first, second, third, fourth] = config.territoryRankBonus
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
    const [first, ...rest] = config.territoryRankBonus
    const restSum = rest.reduce((a, b) => a + b, 0)
    expect(first).toBeGreaterThan(restSum)
  })

  it('returns just the max bonus for a single-team config', () => {
    const config = createRewardConfig(1)
    expect(config.territoryRankBonus).toHaveLength(1)
    expect(config.territoryRankBonus[0]).toBeGreaterThan(0)
  })

  it('is deterministic and independent of teamCount for the top-rank bonus value', () => {
    expect(createRewardConfig(2).territoryRankBonus[0]).toBe(createRewardConfig(6).territoryRankBonus[0])
  })
})
