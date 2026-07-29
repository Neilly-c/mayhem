import type { GameState } from './types'
import { deriveRng } from './rng'

/**
 * 残り1チームになってから経過したtick数。まだ2チーム以上生存している、または既に全滅済みなら
 * `null`(カウントダウン対象外)。「残り1チームになった時点」は、既に脱落した他チームの
 * `eliminatedAtTick`の最大値として求める(=最後に脱落した他チームがいなくなった瞬間)。
 * 開始時点からteamCount:1だった場合など、脱落済みチームが1つもなければtick 0を起点とする。
 */
function soloSurvivorElapsedTicks(state: GameState): number | null {
  const aliveTeams = state.teams.filter((t) => t.alive)
  if (aliveTeams.length !== 1) return null
  const eliminatedTicks = state.teams.filter((t) => !t.alive).map((t) => t.eliminatedAtTick ?? 0)
  const soloSinceTick = eliminatedTicks.length > 0 ? Math.max(...eliminatedTicks) : 0
  return state.tick - soloSinceTick
}

/**
 * ユーザー要望: 陣営の目的がマップ占領率になったため、残り1チームになった時点では即終了しない
 * — そのチームは(リング外に塗りに行くのも含め)自由に占領を続けられる。ただし唯一の生存
 * チームが際限なく自由でいられるのも問題なので、残り1チームになってから
 * `config.lastTeamCountdownTicks`(既定100)経過したら強制的にゲームを終了する。
 * もちろん、それより先にリングダメージで全チームが全滅すればその時点で終了する。
 */
export function isGameOver(state: GameState): boolean {
  if (state.teams.every((t) => !t.alive)) return true
  const elapsed = soloSurvivorElapsedTicks(state)
  return elapsed !== null && elapsed >= state.config.lastTeamCountdownTicks
}

/**
 * UI表示用: 残り1チームになってからのカウントダウン残りtick数。カウントダウン対象外
 * (2チーム以上生存 / 既に終了)なら`null`。
 */
export function lastTeamCountdownRemaining(state: GameState): number | null {
  const elapsed = soloSurvivorElapsedTicks(state)
  if (elapsed === null) return null
  return Math.max(0, state.config.lastTeamCountdownTicks - elapsed)
}

export function getWinnerTeamId(state: GameState): number | null {
  const aliveTeams = state.teams.filter((t) => t.alive)
  return aliveTeams.length === 1 ? aliveTeams[0].id : null
}

function teamTotalHp(state: GameState, teamId: number): number {
  return state.units
    .filter((u) => u.teamId === teamId && u.alive)
    .reduce((sum, u) => sum + u.hp, 0)
}

function teamTerritoryCount(state: GameState, teamId: number): number {
  return state.nodes.filter((n) => n.owner === teamId).length
}

/**
 * ユーザー要望: 陣営の目的をマップ占領率(自陣営の色で塗った通行可能ノードの割合)に変更する
 * (RL報酬は学習をやり直す前提で当面変更しないため、ここでは`getRanking`とは独立した
 * UI/表示用の関数として追加する)。壁ノードは分母に含めない — 占領率100%は「塗りつぶせる
 * 全ノードを塗った状態」を意味する。
 */
export function teamTerritoryRate(state: GameState, teamId: number): number {
  const passableNodes = state.nodes.filter((n) => n.passable)
  if (passableNodes.length === 0) return 0
  const owned = passableNodes.filter((n) => n.owner === teamId).length
  return owned / passableNodes.length
}

/**
 * 占領率降順の最終順位。リング内外は一切考慮しない(§ユーザー要望どおり、リング外の領地も
 * 潰れず、そこへ塗りに行っても構わない)。同率はチームID昇順でタイブレークする(単純さ優先、
 * `getRanking`のような乱数タイブレークは行わない)。テリトリーは生存チーム同士の奪い合いで
 * ゲーム終了まで変動し続けるため、脱落済みチームも含めた最終順位はゲーム終了後にのみ意味を持つ
 * (呼び出し側で`isGameOver`を確認すること)。
 */
export function getTerritoryRanking(state: GameState): number[] {
  return [...state.teams]
    .sort((a, b) => {
      const diff = teamTerritoryRate(state, b.id) - teamTerritoryRate(state, a.id)
      if (diff !== 0) return diff
      return a.id - b.id
    })
    .map((t) => t.id)
}

/**
 * §9 順位付け: 脱落tickが遅い順(まだ脱落していない=最終生存チームが最上位)を第一キーとし、
 * 同一tick脱落(または複数チーム同時生存での決着)は 総HP降順 → テリトリー数降順 →
 * seed由来の乱数 の順でタイブレークする。乱数はチームごとに固定の名前空間から取るため、
 * 呼び出しタイミングに関わらず同じ結果になる。
 */
export function getRanking(state: GameState): number[] {
  const tiebreak = new Map(
    state.teams.map((t) => [t.id, deriveRng(state.seed, `tiebreak:${t.id}`)()]),
  )

  return [...state.teams]
    .sort((a, b) => {
      const aElim = a.eliminatedAtTick ?? Infinity
      const bElim = b.eliminatedAtTick ?? Infinity
      if (aElim !== bElim) return bElim - aElim

      const hpDiff = teamTotalHp(state, b.id) - teamTotalHp(state, a.id)
      if (hpDiff !== 0) return hpDiff

      const territoryDiff = teamTerritoryCount(state, b.id) - teamTerritoryCount(state, a.id)
      if (territoryDiff !== 0) return territoryDiff

      return (tiebreak.get(b.id) as number) - (tiebreak.get(a.id) as number)
    })
    .map((t) => t.id)
}
