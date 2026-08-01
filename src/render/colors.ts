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
  const [r, g, b] = elevationRgb(elevation)
  return `rgb(${r},${g},${b})`
}

function elevationRgb(elevation: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, elevation))
  return [
    Math.round(ELEVATION_LOW[0] + (ELEVATION_HIGH[0] - ELEVATION_LOW[0]) * t),
    Math.round(ELEVATION_LOW[1] + (ELEVATION_HIGH[1] - ELEVATION_LOW[1]) * t),
    Math.round(ELEVATION_LOW[2] + (ELEVATION_HIGH[2] - ELEVATION_LOW[2]) * t),
  ]
}

/** ユーザー要望: 斜め見下ろし表示(§draw.tsのobliqueView)で、持ち上がったノードの「側面」を
 * 塗るための陰影色。立体的なライティングまでは付けず、単純に頂面の色を暗くするだけ。 */
export function elevationSkirtColor(elevation: number): string {
  const [r, g, b] = elevationRgb(elevation)
  const shade = 0.5
  return `rgb(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)})`
}

export const WALL_COLOR = '#222222'
/**
 * ユーザー要望: リング外(危険地帯)は全体に一様な赤を重ね塗りする(地形の上から重ねて描く)。
 * 消去(安全圏の穴あけ)は不透明色で行うため、ここのアルファ値が安全圏に漏れ出すことはない
 * (以前は消去円がこのアルファ値のまま描かれ、安全圏にも薄く色が残るバグがあった)。
 */
export const RING_DANGER_FILL = 'rgba(200,90,30,0.15)'
export const RING_BOUNDARY_COLOR = '#e0d000'
export const RING_NEXT_BOUNDARY_COLOR = 'rgba(224,208,0,0.5)'
export const ATTACK_LINE_COLOR = 'rgba(255,255,255,0.7)'
/** ユーザー要望: 視野が円ではなく星形(コア+6方向の棘)になったため、`showAttackRange`と同じ
 * 単純な円ストロークでは形状を表現できない。`showPatch`と同じ「該当ヘックスを塗る」方式に
 * 変更したので、多数のセルに重ねても濃すぎないようアルファ値を下げてある。 */
export const VISION_RANGE_COLOR = 'rgba(120,180,255,0.22)'
export const ATTACK_RANGE_COLOR = 'rgba(255,120,120,0.7)'
export const PATCH_HIGHLIGHT_COLOR = 'rgba(255,255,0,0.25)'
export const FACING_INDICATOR_FILL = 'rgba(255,255,255,0.95)'
export const FACING_INDICATOR_STROKE = 'rgba(0,0,0,0.6)'
/** ユーザー要望: バフ系アビリティ(damageShield/speedBoost/chainDamage)発動中の見た目を、
 * 種類ごとに完全に分ける(以前は共通の白い点線の輪1種類だけで「全部シールドに見える」問題が
 * あった)。色に加えて`render/draw.ts`側でリングの形状・アニメーションそのものも変える。 */
export const DAMAGE_SHIELD_ACTIVE_COLOR = 'rgba(80,180,255,0.95)'
export const SPEED_BOOST_ACTIVE_COLOR = 'rgba(255,210,60,0.95)'
export const CHAIN_DAMAGE_ACTIVE_COLOR = 'rgba(220,60,255,0.95)'
/** ペイントボール飛行中弾の縁取り。 */
export const PROJECTILE_STROKE_COLOR = 'rgba(255,255,255,0.9)'
/** レーザー光線の縁取り(本体はチームカラー、これは芯を明るく見せる縁)。 */
export const LASER_BEAM_COLOR = 'rgba(255,255,255,0.95)'
