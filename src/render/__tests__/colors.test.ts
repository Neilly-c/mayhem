import { describe, expect, it } from 'vitest'
import { elevationColor, teamColor } from '../colors'

describe('teamColor', () => {
  it('returns a solid rgb() string by default', () => {
    expect(teamColor(0)).toMatch(/^rgb\(\d+,\d+,\d+\)$/)
  })

  it('returns an rgba() string with the requested alpha', () => {
    expect(teamColor(0, 0.3)).toMatch(/^rgba\(\d+,\d+,\d+,0\.3\)$/)
  })

  it('cycles through the palette for team ids beyond its length', () => {
    expect(teamColor(0)).toBe(teamColor(8))
  })

  it('gives different teams different colors', () => {
    expect(teamColor(0)).not.toBe(teamColor(1))
  })
})

describe('elevationColor', () => {
  it('is monotonically brighter for higher elevation', () => {
    const low = elevationColor(0)
    const high = elevationColor(1)
    expect(low).not.toBe(high)
  })

  it('clamps out-of-range input', () => {
    expect(elevationColor(-5)).toBe(elevationColor(0))
    expect(elevationColor(5)).toBe(elevationColor(1))
  })
})
