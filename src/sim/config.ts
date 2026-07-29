import type { SimConfig } from './types'

/** §13 既定値。全数値は調整前提。 */
export function defaultConfig(): SimConfig {
  return {
    mapRadius: 25,
    // 連結性保証(最大連結成分以外を壁化)後に壁が約30%になるよう較正した値。
    // perlinFrequencyを上げてノイズを縮小適用しているため、seed間の壁比率のばらつきは
    // 低周波数のときより小さい(§2.2はseed間の変動を許容しているが、必須ではない)。
    wallThreshold: 0.43,
    perlinFrequency: 0.25,
    teamCount: 8,
    unitsPerTeam: 3,
    unitHP: 100,
    baseSpeed: 0.1,
    territoryMoveBonus: 0.2,
    decisionInterval: 5,
    captureTicks: 10,
    contestedCaptureBehavior: 'freeze',
    territoryAtkBonus: 0.1,
    baseDamage: 1.0,
    highGroundK: 1.0,
    highGroundCoefMin: 0.7,
    highGroundCoefMax: 1.5,
    backAttackDamageCoef: 0.5,
    stationaryAttackDamageCoef: 1.5,
    chainDamageRadius: 1.0,
    chainDamageCoef: 0.3,
    territoryRegenRate: 0.1,
    visionRange: 6.0,
    attackRange: 2.0,
    maxVisibleEnemies: 6,
    patchHops: 4,
    warnTicks: 360,
    shrinkTicks: 180,
    ringRadiusSchedule: [25, 18, 13, 9, 5, 2, 0],
    slipDamage: [0.5, 1, 1.5, 2, 3, 5],
  }
}

export function createConfig(overrides?: Partial<SimConfig>): SimConfig {
  return { ...defaultConfig(), ...overrides }
}
