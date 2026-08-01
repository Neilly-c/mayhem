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

/**
 * ユーザー要望: 視野を「全方向`coreRadius`ホップの正六角形」+「6方向直線上のみ`spikeRange`
 * ホップまで見通せる、幅1マスの棘」の二重形状にする(直線状に飛ぶアビリティの狙い先を、その
 * 方向にだけ遠くまで見通せるようにするため)。棘の判定はキューブ座標の差分(dx,dy,dz)のうち
 * いずれか1つが0であること — これはヘックスグリッド上で2点が6方向のいずれかと厳密に一直線上に
 * あるための必要十分条件(方向ベクトルはキューブ座標で(±1,∓1,0)の並び替えなので、その方向に
 * k歩進んだ差分は必ずどれか1軸が0のまま)。
 */
export function withinVisionStar(a: AxialCoord, b: AxialCoord, coreRadius: number, spikeRange: number): boolean {
  const dist = hexDist(a, b)
  if (dist <= coreRadius) return true
  if (dist > spikeRange) return false
  const ca = axialToCube(a)
  const cb = axialToCube(b)
  return ca.x === cb.x || ca.y === cb.y || ca.z === cb.z
}

/** `withinVisionStar`と同じ形状を原点からの相対オフセット一覧として列挙する(描画用、
 * `render/draw.ts`のオーバーレイが`nodesInRadius`の代わりに使う)。 */
export function visionStarOffsets(coreRadius: number, spikeRange: number): AxialCoord[] {
  const offsets = nodesInRadius(coreRadius)
  for (let dir = 0; dir < 6; dir++) {
    let coord: AxialCoord = { q: 0, r: 0 }
    for (let hops = 1; hops <= spikeRange; hops++) {
      coord = axialAdd(coord, DIRECTIONS[dir])
      if (hops > coreRadius) offsets.push(coord)
    }
  }
  return offsets
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
