import { describe, expect, it } from 'vitest'
import { curriculumSimConfig, defaultCurriculum } from '../curriculum'

describe('curriculumSimConfig', () => {
  it('uses the first stage before any thresholds are reached', () => {
    expect(curriculumSimConfig(0).mapRadius).toBe(8)
    expect(curriculumSimConfig(49).mapRadius).toBe(8)
  })

  it('advances to the next stage exactly at its threshold', () => {
    expect(curriculumSimConfig(50).mapRadius).toBe(14)
    expect(curriculumSimConfig(149).mapRadius).toBe(14)
    expect(curriculumSimConfig(150).mapRadius).toBe(20)
    expect(curriculumSimConfig(300).mapRadius).toBe(25)
  })

  it('stays at the final stage indefinitely past its threshold', () => {
    expect(curriculumSimConfig(1000).mapRadius).toBe(25)
    expect(curriculumSimConfig(1_000_000).mapRadius).toBe(25)
  })

  it('always fixes teamCount:6 and unitsPerTeam:3 regardless of iteration (network-shape invariant)', () => {
    for (const iteration of [0, 10, 60, 200, 500]) {
      const config = curriculumSimConfig(iteration)
      expect(config.teamCount).toBe(6)
      expect(config.unitsPerTeam).toBe(3)
    }
  })

  it('respects a custom stage table instead of the default one', () => {
    const custom = [
      { afterIteration: 0, mapRadius: 5 },
      { afterIteration: 10, mapRadius: 10 },
    ]
    expect(curriculumSimConfig(0, custom).mapRadius).toBe(5)
    expect(curriculumSimConfig(9, custom).mapRadius).toBe(5)
    expect(curriculumSimConfig(10, custom).mapRadius).toBe(10)
  })

  it('defaultCurriculum stages are sorted ascending by afterIteration', () => {
    const stages = defaultCurriculum()
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].afterIteration).toBeGreaterThan(stages[i - 1].afterIteration)
    }
  })
})
