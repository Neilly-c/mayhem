import type { SimConfig } from './types'

/** §13 既定値。全数値は調整前提。 */
export function defaultConfig(): SimConfig {
  return {
    mapRadius: 15, // マップ中心からの半径(ヘクス数)。マップの大きさそのもの。
    wallThreshold: 0.43, // このelevation未満のノードは通行不可の壁になる。
    perlinFrequency: 0.22, // 地形elevationを生成するPerlinノイズの空間周波数。大きいほど起伏が細かくなる。
    teamCount: 8, // チーム数。
    unitsPerTeam: 3, // チームあたりのユニット数。
    unitHP: 100, // ユニットの最大HP。
    baseSpeed: 0.1, // 1tickあたりの基礎移動進捗(エッジ1本=progress 1.0)。
    territoryMoveBonus: 0.8, // 自チーム所有ノード間を移動する際のbaseSpeedへの加算倍率(1+この値)。
    decisionInterval: 5, // RLエージェント/ボットが指令を更新する周期(tick数)。
    captureTicks: 10, // 敵/中立ノードに滞在してから占領が確定するまでのtick数。
    contestedCaptureBehavior: 'freeze', // 複数チームが同一ノードに同時滞在(係争)した際の占領進行の扱い('freeze'=進行停止 / 'reset'=進行リセット)。
    territoryAtkBonus: 0.1, // 自チーム所有ノード上で静止攻撃する際のダメージ倍率加算(1+この値)。
    baseDamage: 1.0, // 攻撃1回あたりの基礎ダメージ。
    highGroundK: 2.0, // 高低差ダメージ補正の傾き係数(標高差×この値がraw倍率に加算される)。
    highGroundCoefMin: 0.5, // 高低差ダメージ補正倍率の下限。
    highGroundCoefMax: 2, // 高低差ダメージ補正倍率の上限。
    backAttackDamageCoef: 0.5, // 対象の背面から攻撃した際のダメージ倍率(正面は1倍のまま)。
    stationaryAttackDamageCoef: 1.5, // 攻撃側がノード上で静止している際、全方向に適用されるダメージ倍率。
    chainDamageRadius: 0, // 主攻撃対象の周囲、連鎖ダメージが波及するワールド距離半径(0で連鎖ダメージ無効)。
    chainDamageCoef: 0.3, // 連鎖ダメージが主攻撃の(補正後)ダメージに対して占める割合。
    territoryRegenRate: 0.5, // 自チーム所有ノード上で静止している際の1tickあたりHP回復量。
    visionRange: 6.0, // 敵ユニットを視認できるワールド距離。
    attackRange: 2.0, // 攻撃可能なワールド距離。
    maxVisibleEnemies: 6, // 観測ベクトルに含める視認中敵ユニットの上限数(近い順、超過分は切り捨て)。
    patchHops: 5, // 観測に含める自己中心の局所地形パッチの半径(ホップ数)。
    warnTicks: 360, // 各リングステージで、次のリング予告(警告)状態が続くtick数。
    shrinkTicks: 180, // 各リングステージで、実際にリングが収縮するのにかかるtick数。
    ringRadiusSchedule: [20, 12, 8, 5, 3, 0], // 各ステージの安全地帯半径(ワールド単位)。要素数-1がステージ数。
    slipDamage: [0.5, 1, 1.5, 2, 3, 5], // 各ステージで安全地帯の外にいる間、1tickあたりに受けるダメージ。
    lastTeamCountdownTicks: 100, // 残り1チームになってからゲーム終了までのカウントダウンtick数。
  }
}

export function createConfig(overrides?: Partial<SimConfig>): SimConfig {
  return { ...defaultConfig(), ...overrides }
}
