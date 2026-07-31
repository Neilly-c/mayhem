import type { GameState } from '../sim'
import { getTerritoryRanking, isGameOver, teamTerritoryRate } from '../sim'
import { computeVisibleEnemies } from '../env'
import { teamColor } from '../render'

/** 棒グラフの表示上限。ユーザー要望で50%→25%に変更(小さな差をより見やすくする)。 */
const TERRITORY_BAR_MAX_PERCENT = 25
/** ユーザー要望: 5%刻みの補助線。0%と上限(container端)は境界線と重複するので除く。 */
const TERRITORY_BAR_GRIDLINE_STEP = 5
const TERRITORY_BAR_GRIDLINES = Array.from(
  { length: Math.floor(TERRITORY_BAR_MAX_PERCENT / TERRITORY_BAR_GRIDLINE_STEP) - 1 },
  (_, i) => (i + 1) * TERRITORY_BAR_GRIDLINE_STEP,
)

interface Props {
  state: GameState
  selectedUnitId: number | null
}

export function DebugPanel({ state, selectedUnitId }: Props) {
  const selectedUnit = selectedUnitId !== null ? state.units.find((u) => u.id === selectedUnitId) : undefined

  // ユーザー要望: 陣営の目的はマップ占領率(リング内外は無関係)。占領率は生存チーム同士の
  // 奪い合いでゲーム終了まで変動し続けるため、脱落済みチームも含めた最終順位はゲームが
  // 本当に終わるまで確定しない。それまでは全チーム一律「生存/全滅」とだけ表示する。
  const gameOver = isGameOver(state)
  const territoryRanking = gameOver ? getTerritoryRanking(state) : null

  const teamSummaries = state.teams.map((team) => {
    const teamUnits = state.units.filter((u) => u.teamId === team.id)
    const aliveUnits = teamUnits.filter((u) => u.alive)
    const totalHp = aliveUnits.reduce((sum, u) => sum + u.hp, 0)
    const territoryPercent = teamTerritoryRate(state, team.id) * 100
    const rank = territoryRanking ? territoryRanking.indexOf(team.id) + 1 : null
    return { team, teamUnits, aliveUnits, totalHp, territoryPercent, rank }
  })

  // ユーザー要望: 占領率の順位入れ替わりが激しく、ソートするとアニメーションが追い付かないため、
  // チーム表は並び替えずチームID順の静的な表にする(占領率降順ソートは廃止)。

  return (
    <div className="debug-panel">
      <h3>チーム</h3>
      <table className="team-status-table">
        <thead>
          <tr>
            <th>チーム</th>
            <th>残数</th>
            <th>HP合計</th>
            <th>占領率</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {teamSummaries.map(({ team, teamUnits, aliveUnits, totalHp, territoryPercent, rank }) => (
            <tr key={team.id} className={team.alive ? undefined : 'eliminated'}>
              <td>
                <span className="team-swatch" style={{ background: teamColor(team.id) }} />
                {team.id}
              </td>
              <td>
                {aliveUnits.length}/{teamUnits.length}
              </td>
              <td>{totalHp.toFixed(1)}</td>
              <td>{territoryPercent.toFixed(2)}%</td>
              <td>{rank !== null ? `${rank}位` : team.alive ? '生存' : '全滅'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ユーザー要望: 状態表の下に占領率の縦棒グラフを追加する(HPではなく占領率、最大25%)。
       * 5%ごとに補助線、25%を超えた系列は光らせる。 */}
      <div className="territory-bar-chart">
        {TERRITORY_BAR_GRIDLINES.map((value) => (
          <div
            key={value}
            className="territory-bar-gridline"
            style={{ bottom: `${(value / TERRITORY_BAR_MAX_PERCENT) * 100}%` }}
          />
        ))}
        {teamSummaries.map(({ team, territoryPercent }) => {
          const barHeightPct = Math.min(100, (territoryPercent / TERRITORY_BAR_MAX_PERCENT) * 100)
          const isOverMax = territoryPercent > TERRITORY_BAR_MAX_PERCENT
          const color = teamColor(team.id)
          return (
            <div
              key={team.id}
              className="territory-bar"
              title={`チーム${team.id}: ${territoryPercent.toFixed(2)}%`}
            >
              <div
                className={`territory-bar-fill${isOverMax ? ' territory-bar-fill--glow' : ''}`}
                style={{
                  height: `${barHeightPct}%`,
                  background: color,
                  boxShadow: isOverMax ? `0 0 6px 2px ${color}, 0 0 16px 4px ${color}` : undefined,
                }}
              />
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
