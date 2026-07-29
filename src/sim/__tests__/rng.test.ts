import { describe, expect, it } from 'vitest'
import { deriveRng, mulberry32, randInt } from '../rng'

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = Array.from({ length: 20 }, () => a())
    const seqB = Array.from({ length: 20 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })

  it('always yields values in [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('deriveRng gives independent, reproducible streams per purpose', () => {
    const elevation1 = deriveRng(100, 'elevation')
    const elevation2 = deriveRng(100, 'elevation')
    const spawn = deriveRng(100, 'spawn')

    expect(elevation1()).toBe(elevation2())
    expect(deriveRng(100, 'elevation')()).not.toBe(spawn())
  })

  it('randInt stays within [0, max)', () => {
    const rng = mulberry32(9)
    for (let i = 0; i < 500; i++) {
      const v = randInt(rng, 5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(5)
      expect(Number.isInteger(v)).toBe(true)
    }
  })
})
