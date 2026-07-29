import { describe, expect, it } from 'vitest'
import { ActorCriticModel } from '../network'
import { evaluateAgainstBots } from '../evaluate'
import { inferObsDim } from '../shapes'

const TINY_CONFIG = {
  mapRadius: 4,
  wallThreshold: 0,
  teamCount: 2,
  unitsPerTeam: 1,
  maxVisibleEnemies: 2,
  decisionInterval: 2,
  baseDamage: 50, // fast, deterministic-ish kills so the smoke test stays quick
  highGroundK: 0,
}

describe('evaluateAgainstBots', () => {
  it('runs end-to-end against every baseline bot kind and produces a well-formed report', () => {
    const obsDim = inferObsDim(TINY_CONFIG, 1)
    const model = ActorCriticModel.build({ obsDim, maxVisibleEnemies: TINY_CONFIG.maxVisibleEnemies, hiddenSizes: [8] })

    const report = evaluateAgainstBots(model, TINY_CONFIG, {
      iteration: 1,
      seedBase: 99,
      matchups: [
        { opponentBotKind: 'scripted', episodes: 2 },
        { opponentBotKind: 'decisionTree', episodes: 2 },
        { opponentBotKind: 'survival', episodes: 2 },
      ],
      maxTicksPerEpisode: 500,
    })

    expect(report.iteration).toBe(1)
    expect(report.matchups).toHaveLength(3)
    for (const m of report.matchups) {
      expect(m.episodes).toBe(2)
      expect(m.winRate).toBeGreaterThanOrEqual(0)
      expect(m.winRate).toBeLessThanOrEqual(1)
      expect(m.avgRank).toBeGreaterThanOrEqual(0)
      expect(m.avgRank).toBeLessThan(2) // teamCount:2 -> ranks are 0 or 1
    }
  })

  it('is deterministic for a given seedBase', () => {
    const obsDim = inferObsDim(TINY_CONFIG, 1)
    const model = ActorCriticModel.build({ obsDim, maxVisibleEnemies: TINY_CONFIG.maxVisibleEnemies, hiddenSizes: [8] })

    const opts = {
      iteration: 1,
      seedBase: 123,
      matchups: [{ opponentBotKind: 'scripted' as const, episodes: 1 }],
      maxTicksPerEpisode: 500,
    }
    const a = evaluateAgainstBots(model, TINY_CONFIG, opts)
    const b = evaluateAgainstBots(model, TINY_CONFIG, opts)
    expect(a).toEqual(b)
  })
})
