import type { GameState, TickEvents } from '../sim'
import { getRanking, isGameOver } from '../sim'
import type { RewardConfig } from './types'

function add(rewards: Record<number, number>, unitId: number, amount: number): void {
  if (amount === 0) return
  rewards[unitId] = (rewards[unitId] ?? 0) + amount
}

/**
 * §11.4 報酬シグナル。1tick分の生の出来事(`TickEvents`)を、そのtick直後の状態`state`を使って
 * `rewards`(unitId毎の累積)に加算する。呼び出し側(`Env.step`)が意思決定間隔D tick分ループしながら
 * 同じ`rewards`オブジェクトへ繰り返し適用することで、そのブロック分の報酬を蓄積する。
 *
 * チームが脱落したtickでは`getRanking`を評価して順位ボーナスを与える。脱落順は`eliminatedAtTick`
 * により後から変わらないため、これは近似ではなくその時点で確定した最終順位そのものである。
 */
export function applyTickRewards(
  rewards: Record<number, number>,
  events: TickEvents,
  state: GameState,
  config: RewardConfig,
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

  for (const capture of events.territoryCaptures) {
    for (const unit of state.units) {
      if (unit.teamId === capture.teamId && unit.alive) add(rewards, unit.id, config.territoryCoef)
    }
  }

  for (const slip of events.slipDamage) {
    add(rewards, slip.unitId, slip.damage * config.slipDamageCoef)
  }

  for (const unit of state.units) {
    if (unit.alive) add(rewards, unit.id, config.survivalReward)
  }

  for (const teamId of events.eliminatedTeams) {
    const rank = getRanking(state).indexOf(teamId)
    const bonus = config.rankBonus[rank] ?? 0
    for (const unit of state.units) {
      if (unit.teamId === teamId) add(rewards, unit.id, bonus)
    }
  }
}

/**
 * ゲーム終了(最後の1チームが確定)した瞬間、勝者チームの生存ユニットに終端ボーナスを一度だけ
 * 付与する。`isGameOver`を自前で検査するため、呼び出し側のガード漏れで途中決着してしまうことはない。
 */
export function applyWinnerBonus(rewards: Record<number, number>, state: GameState, config: RewardConfig): void {
  if (!isGameOver(state)) return
  const winnerTeamId = getRanking(state)[0]
  const winnerTeam = state.teams.find((t) => t.id === winnerTeamId)
  if (!winnerTeam?.alive) return
  const bonus = config.rankBonus[0] ?? 0
  for (const unit of state.units) {
    if (unit.teamId === winnerTeamId && unit.alive) add(rewards, unit.id, bonus)
  }
}
