export type RngFn = () => number

/** xmur3 string hash, used to derive independent 32-bit seeds for named substreams. */
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  h ^= h >>> 16
  return h >>> 0
}

/** mulberry32: small, fast, deterministic PRNG. Returns a function yielding floats in [0, 1). */
export function mulberry32(seed: number): RngFn {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Derives an independent, deterministic RNG stream for a named purpose from a single base seed.
 * All randomness in `sim` (map generation, spawn placement, exploration fallback, ring centers,
 * tiebreaks) must originate from `deriveRng(baseSeed, purpose)` rather than `Math.random()`.
 */
export function deriveRng(baseSeed: number, purpose: string): RngFn {
  return mulberry32(xmur3(`${baseSeed}:${purpose}`))
}

/** Random integer in [0, maxExclusive). */
export function randInt(rng: RngFn, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive)
}
