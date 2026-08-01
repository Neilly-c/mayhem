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
    chainDamageRadius: 1.2, // 連鎖ダメージが波及するワールド距離半径(隣接ヘックスを覆う程度)。chainDamageアビリティ発動中のみ有効。
    chainDamageCoef: 0.3, // 連鎖ダメージが主攻撃の(補正後)ダメージに対して占める割合。chainDamageアビリティのi値と兼用。
    territoryRegenRate: 0.5, // 自チーム所有ノード上で静止している際の1tickあたりHP回復量。
    visionCoreRadius: 3, // 視野: 全方向に見える正六角形コアの半径(ホップ数)。
    visionSpikeRange: 9, // 視野: 6方向直線上のみ、コアを超えて見通せる距離(ホップ数)。
    attackRange: 2.0, // 攻撃可能なワールド距離。
    maxVisibleEnemies: 6, // 観測ベクトルに含める視認中敵ユニットの上限数(近い順、超過分は切り捨て)。
    patchHops: 5, // 観測に含める自己中心の局所地形パッチの半径(ホップ数)。
    paintballSpeedMult: 2, // ペイントボール: 弾速倍率(baseSpeed基準)。
    paintballMaxRange: 7, // ペイントボール: 着弾先に選べる最大距離(ヘックス数)。
    paintballDamage: 20, // ペイントボール: 着弾時、周囲7マス以内の敵へのダメージ。
    paintballCooldown: 180, // ペイントボール: 発動クールダウン(tick)。
    laserRange: 7, // レーザー: 直線の長さ(ヘックス数)。
    laserDamage: 20, // レーザー: 直線上の敵へのダメージ。
    laserCooldown: 180, // レーザー: 発動クールダウン(tick)。
    damageShieldCoef: 0.3, // ダメージシールド: 発動中のリング以外の被ダメージ倍率。
    damageShieldDuration: 60, // ダメージシールド: 効果時間(tick)。
    damageShieldCooldown: 400, // ダメージシールド: 発動クールダウン(tick)。
    speedBoostMult: 1.6, // スピードブースト: 発動中の移動速度倍率。
    speedBoostDuration: 30, // スピードブースト: 効果時間(tick)。
    speedBoostCooldown: 120, // スピードブースト: 発動クールダウン(tick)。
    chainAbilityDuration: 30, // 連鎖ダメージ有効化: 効果時間(tick)。
    chainAbilityCooldown: 180, // 連鎖ダメージ有効化: 発動クールダウン(tick)。
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
