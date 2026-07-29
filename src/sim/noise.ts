import type { RngFn } from './rng'

const GRAD2: readonly [number, number][] = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
]

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

/** Classic 2D Perlin noise with a permutation table shuffled by a seeded RNG (no Math.random). */
export class PerlinNoise2D {
  private readonly perm: Uint8Array

  constructor(rng: RngFn) {
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = p[i]
      p[i] = p[j]
      p[j] = tmp
    }
    this.perm = new Uint8Array(512)
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
  }

  private gradDot(hash: number, x: number, y: number): number {
    const g = GRAD2[hash & 7]
    return g[0] * x + g[1] * y
  }

  /** Raw Perlin value, roughly in [-1, 1]. */
  raw(x: number, y: number): number {
    const xi = Math.floor(x) & 255
    const yi = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)

    const u = fade(xf)
    const v = fade(yf)

    const perm = this.perm
    const aa = perm[perm[xi] + yi]
    const ab = perm[perm[xi] + yi + 1]
    const ba = perm[perm[xi + 1] + yi]
    const bb = perm[perm[xi + 1] + yi + 1]

    const x1 = lerp(this.gradDot(aa, xf, yf), this.gradDot(ba, xf - 1, yf), u)
    const x2 = lerp(this.gradDot(ab, xf, yf - 1), this.gradDot(bb, xf - 1, yf - 1), u)
    return lerp(x1, x2, v)
  }

  /** Normalized to [0, 1]. */
  normalized(x: number, y: number): number {
    const v = this.raw(x, y)
    return Math.min(1, Math.max(0, (v + 1) / 2))
  }
}
