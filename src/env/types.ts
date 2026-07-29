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

/** §11.4 報酬の合成係数。すべてconfig化し、自己対戦での調整を前提とする。
 * ユーザー要望: 陣営の目的がマップ占領率になったことに合わせて刷新(旧`territoryCoef`/`rankBonus`は
 * 全滅順位ベースの脱落順で決まっていたため撤廃)。 */
export interface RewardConfig {
  damageDealtCoef: number
  damageTakenCoef: number
  killBonus: number
  deathPenalty: number
  survivalReward: number
  slipDamageCoef: number
  /** ユーザー要望: 占領率(`teamTerritoryRate`)そのものに対するpotential-basedシェイピング。
   * `Φ(s) = teamTerritoryRate(state, teamId)`の差分`Φ(s') - Φ(s)`にこの係数を掛けて毎tick加算する
   * (`nextRingShapingCoef`と同じ手法)。ノード新規占有イベントごとの固定ボーナスだった旧
   * `territoryCoef`と違い、占有率が上がった分だけ+、奪還されて下がった分だけ-と対称的に効く
   * (`rewards.ts`参照)。 */
  territoryRateShapingCoef: number
  /** ユーザー要望: ゲーム終了時点の自チーム最終占領率(0〜1)に比例して全チームへ加算する終端
   * ボーナス。`territoryRankBonus`(順位)と独立に、1位を逃しても実際に塗れた分だけ報酬が出る
   * ようにする(`rewards.ts`の終端ボーナス処理参照)。 */
  territoryRateTerminalCoef: number
  /** territoryRankBonus[i] = 占領率降順(`getTerritoryRanking`)で順位iのチームに与える終端
   * ボーナス。降順、長さ=teamCount。旧`rankBonus`は脱落順(`getRanking`)ベースだったが、
   * 占領率は生存チーム同士の奪い合いでゲーム終了まで変動し続けるため、`isGameOver`成立時に
   * 全チーム一斉に付与する形に変更した(`rewards.ts`参照)。 */
  territoryRankBonus: number[]
  /** ユーザー要望: 次のリング(予告円)へ先回りするインセンティブ。ポテンシャルベースシェイピング
   * `Φ(s) = -(次のリング境界からのはみ出し距離、内側なら0)`の差分`Φ(s') - Φ(s)`にこの係数を
   * 掛けて毎tick加算する — 被弾する前から近づくこと自体に報酬が出るため、`slipDamageCoef`のような
   * 事後ペナルティだけでは学習しにくい「先回り」行動を後押しする(`rewards.ts`参照)。 */
  nextRingShapingCoef: number
}
