import type { AxialCoord, Vec2 } from './types'

const SQRT3_2 = Math.sqrt(3) / 2

/** The 6 axial neighbor offsets, in world-angle order (0°, 60°, ..., 300°). Index doubles as `dir` in Command.moveDirection. */
export const DIRECTIONS: readonly AxialCoord[] = [
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
]

export interface CubeCoord {
  x: number
  y: number
  z: number
}

export function axialToCube(a: AxialCoord): CubeCoord {
  const x = a.q
  const z = a.r
  const y = -x - z
  return { x, y, z }
}

/** Hop distance between two axial coordinates on the hex grid. */
export function hexDist(a: AxialCoord, b: AxialCoord): number {
  const ca = axialToCube(a)
  const cb = axialToCube(b)
  return (Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y) + Math.abs(ca.z - cb.z)) / 2
}

/** 2D embedding used for rendering and continuous edge positions. Edge length = 1.0. */
export function world(a: AxialCoord): Vec2 {
  return { x: a.q + a.r * 0.5, y: a.r * SQRT3_2 }
}

export function worldDist(a: AxialCoord, b: AxialCoord): number {
  const wa = world(a)
  const wb = world(b)
  return Math.hypot(wa.x - wb.x, wa.y - wb.y)
}

export function axialAdd(a: AxialCoord, b: AxialCoord): AxialCoord {
  return { q: a.q + b.q, r: a.r + b.r }
}

export function axialKey(a: AxialCoord): string {
  return `${a.q},${a.r}`
}

/** All axial coords within hop-distance `radius` of the origin, ascending ring order. */
export function nodesInRadius(radius: number): AxialCoord[] {
  const coords: AxialCoord[] = []
  for (let q = -radius; q <= radius; q++) {
    const rMin = Math.max(-radius, -q - radius)
    const rMax = Math.min(radius, -q + radius)
    for (let r = rMin; r <= rMax; r++) {
      coords.push({ q, r })
    }
  }
  return coords
}
