/** §11.2 固定長エゴセントリック観測。`vector`は正規化済みの平坦な数値配列(JSON直列化可能)。 */
export interface Observation {
  vector: number[]
  /** 観測の敵スロットiに対応するユニットID。空きスロットは-1でパディング。攻撃ヘッドのデコードに使う。 */
  visibleEnemyIds: number[]
}

/** §11.3 行動マスク。無効な手はfalse。 */
export interface ActionMask {
  /** 長さ7: [その場に静止, 6方向]。 */
  move: boolean[]
  /** 長さN+1: [攻撃しない, 視認中敵スロット0..N-1]。 */
  attack: boolean[]
}

/** §11.3 `MultiDiscrete([7, N+1])`の1エージェント分の行動。 */
export interface ActionInput {
  move: number
  attack: number
}

export interface StepInfo {
  actionMask: ActionMask
  visibleEnemyIds: number[]
}

/** §11.5 PettingZoo Parallel風の`step`戻り値。キーはユニットID。 */
export interface StepResult {
  observations: Record<number, Observation>
  rewards: Record<number, number>
  terminations: Record<number, boolean>
  truncations: Record<number, boolean>
  infos: Record<number, StepInfo>
}

/** §11.4 報酬の合成係数。すべてconfig化し、自己対戦での調整を前提とする。 */
export interface RewardConfig {
  damageDealtCoef: number
  damageTakenCoef: number
  killBonus: number
  deathPenalty: number
  territoryCoef: number
  survivalReward: number
  slipDamageCoef: number
  /** rankBonus[i] = 順位i(0=優勝)のチームに与える終端ボーナス。降順、長さ=teamCount。 */
  rankBonus: number[]
  /** ユーザー要望: 次のリング(予告円)へ先回りするインセンティブ。ポテンシャルベースシェイピング
   * `Φ(s) = -(次のリング境界からのはみ出し距離、内側なら0)`の差分`Φ(s') - Φ(s)`にこの係数を
   * 掛けて毎tick加算する — 被弾する前から近づくこと自体に報酬が出るため、`slipDamageCoef`のような
   * 事後ペナルティだけでは学習しにくい「先回り」行動を後押しする(`rewards.ts`参照)。 */
  nextRingShapingCoef: number
}
