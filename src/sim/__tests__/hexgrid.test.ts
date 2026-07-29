import { describe, expect, it } from 'vitest'
import { DIRECTIONS, axialAdd, hexDist, nodesInRadius, worldDist } from '../hexgrid'

describe('hexgrid', () => {
  it('has 6 neighbor directions, each distance 1 from the origin', () => {
    expect(DIRECTIONS).toHaveLength(6)
    for (const d of DIRECTIONS) {
      expect(hexDist({ q: 0, r: 0 }, d)).toBe(1)
    }
  })

  it('computes known hop distances', () => {
    expect(hexDist({ q: 0, r: 0 }, { q: 0, r: 0 })).toBe(0)
    expect(hexDist({ q: 3, r: -2 }, { q: 0, r: 0 })).toBe(3)
    expect(hexDist({ q: 2, r: 2 }, { q: -1, r: -1 })).toBe(6)
  })

  it('embeds adjacent nodes at world distance 1.0', () => {
    const origin = { q: 0, r: 0 }
    for (const d of DIRECTIONS) {
      expect(worldDist(origin, axialAdd(origin, d))).toBeCloseTo(1.0, 10)
    }
  })

  it('generates the expected node count for a given radius (1 + 3R(R+1))', () => {
    for (const r of [1, 5, 10, 25]) {
      const coords = nodesInRadius(r)
      expect(coords.length).toBe(1 + 3 * r * (r + 1))
    }
  })

  it('every generated coordinate is within hop-distance radius of the origin', () => {
    const radius = 8
    const coords = nodesInRadius(radius)
    for (const c of coords) {
      expect(hexDist({ q: 0, r: 0 }, c)).toBeLessThanOrEqual(radius)
    }
  })

  it('world() is linear: distances scale with the world embedding, not hop count alone', () => {
    // Two hops in a straight line should be world-distance 2.0
    const origin = { q: 0, r: 0 }
    const twoAway = axialAdd(axialAdd(origin, DIRECTIONS[0]), DIRECTIONS[0])
    expect(worldDist(origin, twoAway)).toBeCloseTo(2.0, 10)
  })
})
