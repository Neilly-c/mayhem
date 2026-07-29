import { describe, expect, it } from 'vitest'
import { inferObsDim } from '../shapes'

describe('inferObsDim', () => {
  it('returns a positive integer for a small config', () => {
    const dim = inferObsDim({ mapRadius: 5, wallThreshold: 0, teamCount: 2, unitsPerTeam: 2, maxVisibleEnemies: 3 })
    expect(Number.isInteger(dim)).toBe(true)
    expect(dim).toBeGreaterThan(0)
  })

  it('is deterministic for the same config and seed', () => {
    const config = { mapRadius: 5, wallThreshold: 0, teamCount: 3, unitsPerTeam: 2, maxVisibleEnemies: 4 }
    expect(inferObsDim(config, 1)).toBe(inferObsDim(config, 1))
  })

  it('grows when maxVisibleEnemies increases (more enemy-feature slots)', () => {
    const base = { mapRadius: 5, wallThreshold: 0, teamCount: 3, unitsPerTeam: 2 }
    const small = inferObsDim({ ...base, maxVisibleEnemies: 2 })
    const large = inferObsDim({ ...base, maxVisibleEnemies: 6 })
    expect(large).toBeGreaterThan(small)
  })

  it('grows when unitsPerTeam increases (more ally-feature slots)', () => {
    const base = { mapRadius: 5, wallThreshold: 0, teamCount: 3, maxVisibleEnemies: 3 }
    const fewer = inferObsDim({ ...base, unitsPerTeam: 1 })
    const more = inferObsDim({ ...base, unitsPerTeam: 4 })
    expect(more).toBeGreaterThan(fewer)
  })

  it('throws a clear error if no agents spawn for the given config', () => {
    expect(() => inferObsDim({ teamCount: 0, unitsPerTeam: 0 })).toThrow(/no agents/i)
  })
})
