import type { GameState, TickEvents, UnitState } from '../sim'
import { getTerritoryRanking, isGameOver, teamTerritoryRate, unitWorldPos, world, worldDistBetween } from '../sim'
import type { RewardConfig } from './types'

function add(rewards: Record<number, number>, unitId: number, amount: number): void {
  if (amount === 0) return
  rewards[unitId] = (rewards[unitId] ?? 0) + amount
}

/** 次のリング(予告円)の境界からのはみ出し距離。内側(またはちょうど境界上)なら0。 */
function distanceOutsideNextRing(state: GameState, unit: UnitState): number {
  const nextCenterWorld = world(state.nodes[state.ring.nextCenter])
  const dist = worldDistBetween(unitWorldPos(state, unit), nextCenterWorld)
  return Math.max(0, dist - state.ring.nextRadius)
}

/**
 * §11.4 報酬シグナル。1tick分の生の出来事(`TickEvents`)を、そのtick直後の状態`state`を使って
 * `rewards`(unitId毎の累積)に加算する。呼び出し側(`Env.step`)が意思決定間隔D tick分ループしながら
 * 同じ`rewards`オブジェクトへ繰り返し適用することで、そのブロック分の報酬を蓄積する。
 *
 * ユーザー要望: 陣営の目的がマップ占領率になったため、脱落順(`getRanking`)ベースの終端ボーナスは
 * 撤廃した — 占領率は生存チーム同士の奪い合いでゲーム終了まで変動し続けるため、脱落した瞬間に
 * 順位を確定させることができない。終端ボーナスは`applyTerritoryTerminalBonus`が`isGameOver`成立
 * 時に全チーム一斉に付与する(このファイルの別関数)。
 *
 * `ringPotentialMemo`: ユーザー要望の「次のリングへの先回り」シェイピング用。ポテンシャル関数
 * `Φ(s) = -distanceOutsideNextRing(s)`の**前tickからの差分**`Φ(s') - Φ(s)`を
 * `nextRingShapingCoef`倍して毎tick加算する(Ng et al. 1999のpotential-based shapingに準拠 —
 * 割引率γは1として近似している。1tickあたりの差分にとどめる分には既定のγ=0.99との乖離は
 * 無視できるほど小さい)。差分を取るには前tickのΦを覚えておく必要があるため、呼び出し側
 * (`Env`)がユニットID毎の前回値をこの`Map`として持ち回し、エピソードが変わったら(ユニットIDが
 * 使い回されるため)必ずクリアする。あるユニットの初回tickは差分0からスタートする
 * (突然大きな報酬/罰が出るのを防ぐ)。
 *
 * `territoryPotentialMemo`: 同じpotential-based shapingを占領率(`teamTerritoryRate`)に対して
 * 適用する。占領率はチーム単位の値(そのチームの全ユニットで共通)なので、`ringPotentialMemo`と
 * 異なり**チームID**をキーに持ち回る。奪った分だけ+、奪還された分だけ-と対称的に効く(旧
 * `territoryCoef`はノード新規占有イベントごとの固定ボーナスで、奪還時のペナルティが無かった)。
 */
export function applyTickRewards(
  rewards: Record<number, number>,
  events: TickEvents,
  state: GameState,
  config: RewardConfig,
  ringPotentialMemo: Map<number, number>,
  territoryPotentialMemo: Map<number, number>,
): void {
  for (const c of events.combat) {
    add(rewards, c.attackerId, c.damage * config.damageDealtCoef)
    add(rewards, c.targetId, c.damage * config.damageTakenCoef)
  }

  for (const death of events.deaths) {
    add(rewards, death.unitId, config.deathPenalty)
    if (death.killerTeamId !== null) {
      for (const unit of state.units) {
        if (unit.teamId === death.killerTeamId && unit.alive) add(rewards, unit.id, config.killBonus)
      }
    }
  }

  for (const slip of events.slipDamage) {
    add(rewards, slip.unitId, slip.damage * config.slipDamageCoef)
  }

  const territoryRateThisTick = new Map<number, number>()
  const territoryRateOf = (teamId: number): number => {
    let rate = territoryRateThisTick.get(teamId)
    if (rate === undefined) {
      rate = teamTerritoryRate(state, teamId)
      territoryRateThisTick.set(teamId, rate)
    }
    return rate
  }

  for (const unit of state.units) {
    if (!unit.alive) continue
    add(rewards, unit.id, config.survivalReward)

    const ringPotential = -distanceOutsideNextRing(state, unit)
    const prevRingPotential = ringPotentialMemo.get(unit.id) ?? ringPotential
    add(rewards, unit.id, config.nextRingShapingCoef * (ringPotential - prevRingPotential))
    ringPotentialMemo.set(unit.id, ringPotential)

    const territoryPotential = territoryRateOf(unit.teamId)
    const prevTerritoryPotential = territoryPotentialMemo.get(unit.teamId) ?? territoryPotential
    add(rewards, unit.id, config.territoryRateShapingCoef * (territoryPotential - prevTerritoryPotential))
  }

  for (const [teamId, rate] of territoryRateThisTick) territoryPotentialMemo.set(teamId, rate)
}

/**
 * ユーザー要望: ゲーム終了(全チーム全滅、または残り1チームのカウントダウン終了。`isGameOver`)の
 * 瞬間、生存・脱落を問わず全チームに対して占領率ベースの終端ボーナスを一度だけ付与する
 * (旧`applyWinnerBonus`は勝者1チームのみを見ていたが、占領率は脱落済みチームにも意味のある値
 * なので全チームに対して計算する — ただし報酬を受け取れるのは各チームの生存ユニットのみ、
 * 全滅済みチームは受け取り手がいないため実質的に付与されない)。`territoryRankBonus`(占領率
 * 降順の順位ボーナス)と`territoryRateTerminalCoef`(最終占領率そのものに比例するボーナス)の
 * 合計を加算する。`isGameOver`を自前で検査するため、呼び出し側のガード漏れで途中決着して
 * しまうことはない。
 */
export function applyTerritoryTerminalBonus(rewards: Record<number, number>, state: GameState, config: RewardConfig): void {
  if (!isGameOver(state)) return
  const ranking = getTerritoryRanking(state)
  for (const team of state.teams) {
    const rank = ranking.indexOf(team.id)
    const rate = teamTerritoryRate(state, team.id)
    const bonus = (config.territoryRankBonus[rank] ?? 0) + config.territoryRateTerminalCoef * rate
    for (const unit of state.units) {
      if (unit.teamId === team.id && unit.alive) add(rewards, unit.id, bonus)
    }
  }
}
