import type { GameState } from './types'
import { deriveRng } from './rng'

export function isGameOver(state: GameState): boolean {
  return state.teams.filter((t) => t.alive).length <= 1
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
