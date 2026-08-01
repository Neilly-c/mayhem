import type { AbilityKind } from '../sim'
import { isDirectionalAbility } from '../sim'

/**
 * ユーザー要望: ユニット形状(§draw.ts)とチームパネルの凡例(§DebugPanel.tsx)の両方が参照する、
 * アビリティごとの見た目・表示名の単一の対応表(ここを直せば両方に反映される)。
 */
export type AbilityShape = 'circle' | 'triangle' | 'hexagon' | 'diamond' | 'star'

export const ABILITY_ORDER: readonly AbilityKind[] = [
  'paintball',
  'laser',
  'damageShield',
  'speedBoost',
  'chainDamage',
]

export const ABILITY_SHAPES: Record<AbilityKind, AbilityShape> = {
  paintball: 'circle',
  laser: 'triangle',
  damageShield: 'hexagon',
  speedBoost: 'diamond',
  chainDamage: 'star',
}

export const ABILITY_LABELS: Record<AbilityKind, string> = {
  paintball: 'ペイントボール',
  laser: 'レーザー',
  damageShield: 'ダメージシールド',
  speedBoost: 'スピードブースト',
  chainDamage: 'チェインダメージ',
}

/** バフ系(発動中/待機中の状態を持つ)かどうか。paintball/laserは即時発動でクールダウンのみ持つ。
 * 判定の実体は`sim/abilities.ts`の`isDirectionalAbility`(§env/actions.tsの行動マスクとも共有) —
 * ここでは表示コード向けに読みやすい名前で再公開するだけ。 */
export function isBuffAbility(kind: AbilityKind): boolean {
  return !isDirectionalAbility(kind)
}
