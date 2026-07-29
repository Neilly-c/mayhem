import type { RewardConfig } from './types'

/**
 * ユーザー要望: 上位になるほど傾斜を強くつけ、全チームが占領率1位を最優先するようにする。
 * 線形ではなく等比減衰(1つ順位が下がるごとにdecay倍)にすることで、1位とそれ以外の差を
 * 大きく開けつつ、下位同士の差は自然に圧縮される。maxを引き上げることで、終局の順位ボーナスが
 * エピソード中の per-tick shaping報酬の累計を上回りやすくなり、「1位になること」自体が支配的な
 * 目標になる。算出元が`getRanking`(脱落順)から`getTerritoryRanking`(占領率順)に変わった以外は
 * 旧`defaultRankBonus`と同じ形状。
 */
function defaultTerritoryRankBonus(teamCount: number): number[] {
  const max = 50
  const decay = 0.4
  if (teamCount <= 1) return [max]
  return Array.from({ length: teamCount }, (_, i) => max * decay ** i)
}

/** §11.4 既定の報酬係数。数値はすべて自己対戦での調整前提。 */
export function defaultRewardConfig(teamCount: number): RewardConfig {
  return {
    damageDealtCoef: 0.01,
    damageTakenCoef: -0.01,
    // ユーザー要望: 敵撃破は目的そのものではなく手段(奪還・再占領を防ぐ)になったため、
    // 旧来より小さめに抑える(過大評価すると占領そっちのけで殺し合いに寄ってしまう)。
    killBonus: 0.3,
    // 死亡=即敗北ではなくなった(残り1チームでもカウントダウンまで続行)ため、旧来より軽める。
    deathPenalty: -1.0,
    // 占領率ポテンシャル(下記)が暗に生存動機を含むため、旧来より軽める。
    survivalReward: 0.0005,
    slipDamageCoef: -0.03,
    // 占領率1%(0.01)ぶん変化した場合の報酬0.05相当。最終占領率25%で着地した場合、
    // エピソード累積でおよそ+1.25程度(γ≈1近似、nextRingShapingCoefと同じ考え方)。
    territoryRateShapingCoef: 5.0,
    // 終了時点の最終占領率(0〜1)に比例した終端ボーナス。100%到達で+30、50%到達で+15。
    territoryRateTerminalCoef: 30,
    territoryRankBonus: defaultTerritoryRankBonus(teamCount),
    // world距離1単位ぶん次のリングへ近づいた場合の報酬。baseSpeed(既定0.1)相当の前進で
    // 約0.01/tick — survivalReward(0.0005/tick)より一段強く、しかし戦闘系の係数を圧倒しない程度。
    nextRingShapingCoef: 0.1,
  }
}

export function createRewardConfig(teamCount: number, overrides?: Partial<RewardConfig>): RewardConfig {
  return { ...defaultRewardConfig(teamCount), ...overrides }
}
