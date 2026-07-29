import type { RewardConfig } from './types'

/**
 * ユーザー要望: 上位になるほど傾斜を強くつけ、全チームが優勝(1位)を最優先するようにする。
 * 線形ではなく等比減衰(1つ順位が下がるごとにdecay倍)にすることで、1位とそれ以外の差を
 * 大きく開けつつ、下位同士の差は自然に圧縮される。maxを引き上げることで、終局の順位ボーナスが
 * エピソード中の per-tick shaping報酬の累計を上回りやすくなり、「勝つこと」自体が支配的な目標になる。
 */
function defaultRankBonus(teamCount: number): number[] {
  const max = 50
  const decay = 0.4
  if (teamCount <= 1) return [max]
  return Array.from({ length: teamCount }, (_, i) => max * decay ** i)
}

/** §11.4 既定の報酬係数。数値はすべて自己対戦での調整前提。 */
export function defaultRewardConfig(teamCount: number): RewardConfig {
  return {
    damageDealtCoef: 0.01,
    damageTakenCoef: -0.03,
    killBonus: 1.0,
    deathPenalty: -3.0,
    territoryCoef: 0.02,
    survivalReward: 0.001,
    slipDamageCoef: -0.03,
    rankBonus: defaultRankBonus(teamCount),
  }
}

export function createRewardConfig(teamCount: number, overrides?: Partial<RewardConfig>): RewardConfig {
  return { ...defaultRewardConfig(teamCount), ...overrides }
}
