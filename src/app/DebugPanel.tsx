import type { GameState } from '../sim'
import { getRanking, isGameOver } from '../sim'
import { computeVisibleEnemies } from '../env'
import { teamColor } from '../render'

/**
 * 脱落済みチームの順位は`getRanking`が返す時点でその後変わらない(まだ生存中のチームは常に
 * `eliminatedAtTick`が未確定=最大値扱いで上位に来るため)。生存中のチームはゲーム終了(最後の
 * 1チームが確定)まで順位が確定しないので、その間は`null`を返して「生存」のまま表示させる。
 */
function confirmedRank(state: GameState, teamId: number): number | null {
  const team = state.teams.find((t) => t.id === teamId)
  if (!team) return null
  if (!team.alive) return getRanking(state).indexOf(team.id) + 1
  return isGameOver(state) ? 1 : null
}

interface Props {
  state: GameState
  selectedUnitId: number | null
}

export function DebugPanel({ state, selectedUnitId }: Props) {
  const selectedUnit = selectedUnitId !== null ? state.units.find((u) => u.id === selectedUnitId) : undefined

  const teamSummaries = state.teams.map((team) => {
    const teamUnits = state.units.filter((u) => u.teamId === team.id)
    const aliveUnits = teamUnits.filter((u) => u.alive)
    const totalHp = aliveUnits.reduce((sum, u) => sum + u.hp, 0)
    const maxHp = teamUnits.length * state.config.unitHP
    return { team, teamUnits, aliveUnits, totalHp, maxHp, rank: confirmedRank(state, team.id) }
  })

  return (
    <div className="debug-panel">
      <h3>チーム</h3>
      <table className="team-status-table">
        <thead>
          <tr>
            <th>チーム</th>
            <th>残数</th>
            <th>HP合計</th>
            <th>撃破数</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {teamSummaries.map(({ team, teamUnits, aliveUnits, totalHp, rank }) => (
            <tr key={team.id} className={team.alive ? undefined : 'eliminated'}>
              <td>
                <span className="team-swatch" style={{ background: teamColor(team.id) }} />
                {team.id}
              </td>
              <td>
                {aliveUnits.length}/{teamUnits.length}
              </td>
              <td>{totalHp.toFixed(1)}</td>
              <td>{team.killCount}</td>
              <td>{rank !== null ? `${rank}位` : '生存'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ユーザー要望: 状態表の下にチームHPの縦棒グラフを追加する。 */}
      <div className="hp-bar-chart">
        {teamSummaries.map(({ team, totalHp, maxHp }) => {
          const pct = maxHp > 0 ? (totalHp / maxHp) * 100 : 0
          return (
            <div key={team.id} className="hp-bar" title={`チーム${team.id}: ${totalHp.toFixed(0)} / ${maxHp}`}>
              <div className="hp-bar-fill" style={{ height: `${pct}%`, background: teamColor(team.id) }} />
            </div>
          )
        })}
      </div>

      <h3>選択中ユニット</h3>
      {selectedUnit ? (
        <dl>
          <dt>ID / チーム</dt>
          <dd>
            {selectedUnit.id} / チーム{selectedUnit.teamId}
          </dd>
          <dt>HP</dt>
          <dd>
            {selectedUnit.hp.toFixed(1)} / {state.config.unitHP}
          </dd>
          <dt>コマンド</dt>
          <dd>{selectedUnit.command.type}</dd>
          <dt>攻撃対象</dt>
          <dd>{selectedUnit.attackTarget ?? 'なし'}</dd>
          <dt>視認中の敵</dt>
          <dd>{computeVisibleEnemies(state, selectedUnit).length}体</dd>
        </dl>
      ) : (
        <p>キャンバス上のユニットをクリックして選択してください。</p>
      )}
    </div>
  )
}
