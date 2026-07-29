const TEAM_PALETTE: readonly [number, number, number][] = [
  [245, 25, 125],
  [60, 240, 75],
  [245, 130, 49],
  [24, 252, 204],
  [200, 120, 245],
  [45, 140, 250],
  [87, 49, 246],
  [255, 225, 25],
]

export function teamColor(teamId: number, alpha = 1): string {
  const [r, g, b] = TEAM_PALETTE[teamId % TEAM_PALETTE.length]
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
}

// 標高[0,1] -> 濃紺(低地)から明るいシアン(高地)へのグラデーション。ユーザー要望: グレースケールは
// 高低差が読み取りづらかったため、輝度差だけでなく色相差も使うことでコントラストを上げる。
const ELEVATION_LOW: readonly [number, number, number] = [6, 10, 22]
const ELEVATION_HIGH: readonly [number, number, number] = [220, 235, 255]

export function elevationColor(elevation: number): string {
  const t = Math.min(1, Math.max(0, elevation))
  const r = Math.round(ELEVATION_LOW[0] + (ELEVATION_HIGH[0] - ELEVATION_LOW[0]) * t)
  const g = Math.round(ELEVATION_LOW[1] + (ELEVATION_HIGH[1] - ELEVATION_LOW[1]) * t)
  const b = Math.round(ELEVATION_LOW[2] + (ELEVATION_HIGH[2] - ELEVATION_LOW[2]) * t)
  return `rgb(${r},${g},${b})`
}

export const WALL_COLOR = '#222222'
/**
 * ユーザー要望: リング外(危険地帯)は全体に一様な赤を重ね塗りする(地形の上から重ねて描く)。
 * 消去(安全圏の穴あけ)は不透明色で行うため、ここのアルファ値が安全圏に漏れ出すことはない
 * (以前は消去円がこのアルファ値のまま描かれ、安全圏にも薄く色が残るバグがあった)。
 */
export const RING_DANGER_FILL = 'rgba(200,90,30,0.45)'
export const RING_BOUNDARY_COLOR = '#e0d000'
export const RING_NEXT_BOUNDARY_COLOR = 'rgba(224,208,0,0.5)'
export const ATTACK_LINE_COLOR = 'rgba(255,255,255,0.7)'
export const VISION_RANGE_COLOR = 'rgba(120,180,255,0.6)'
export const ATTACK_RANGE_COLOR = 'rgba(255,120,120,0.7)'
export const PATCH_HIGHLIGHT_COLOR = 'rgba(255,255,0,0.25)'
export const FACING_INDICATOR_FILL = 'rgba(255,255,255,0.95)'
export const FACING_INDICATOR_STROKE = 'rgba(0,0,0,0.6)'
