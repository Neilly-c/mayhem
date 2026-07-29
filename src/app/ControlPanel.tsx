import { useState } from 'react'
import { teamColor } from '../render'
import type { PlaybackMode, RlSlot, RlSlotStatus, SimulationFormConfig, TeamLogicKind } from './useSimulationLoop'

const BOT_LABEL: Record<TeamLogicKind, string> = {
  scripted: 'スクリプト',
  decisionTree: '判断木',
  survival: '生存優先',
  rlBest: 'RL: 最良チェックポイント',
  rlLatest: 'RL: 最新チェックポイント',
}

const RL_STATUS_LABEL: Record<RlSlotStatus, string> = {
  idle: '',
  loading: '読み込み中…',
  loaded: '',
  error: '読み込み失敗(npm run devでチェックポイントが生成されているか確認してください)',
}

interface Props {
  playing: boolean
  ticksPerSecond: number
  mode: PlaybackMode
  seed: number
  configForm: SimulationFormConfig
  canReplay: boolean
  gameOver: boolean
  botAssignment: Map<number, TeamLogicKind>
  rlSlotStatus: Record<RlSlot, RlSlotStatus>
  onPlay: () => void
  onPause: () => void
  onStepOnce: () => void
  onSetTicksPerSecond: (n: number) => void
  onReset: (seed: number, config: SimulationFormConfig) => void
  onStartReplay: () => void
  onSetTeamBot: (teamId: number, kind: TeamLogicKind) => void
  showVision: boolean
  showAttackRange: boolean
  showPatch: boolean
  onToggleVision: () => void
  onToggleAttackRange: () => void
  onTogglePatch: () => void
}

export function ControlPanel({
  playing,
  ticksPerSecond,
  mode,
  seed,
  configForm,
  canReplay,
  gameOver,
  botAssignment,
  rlSlotStatus,
  onPlay,
  onPause,
  onStepOnce,
  onSetTicksPerSecond,
  onReset,
  onStartReplay,
  onSetTeamBot,
  showVision,
  showAttackRange,
  showPatch,
  onToggleVision,
  onToggleAttackRange,
  onTogglePatch,
}: Props) {
  const [seedInput, setSeedInput] = useState(seed)
  const [mapRadiusInput, setMapRadiusInput] = useState(configForm.mapRadius)
  const [teamCountInput, setTeamCountInput] = useState(configForm.teamCount)
  const [unitsPerTeamInput, setUnitsPerTeamInput] = useState(configForm.unitsPerTeam)

  return (
    <div className="control-panel">
      <section>
        <h2>再生</h2>
        <div className="button-row">
          <button type="button" onClick={playing ? onPause : onPlay}>
            {playing ? '停止' : '再生'}
          </button>
          <button type="button" onClick={onStepOnce} disabled={playing}>
            1tickステップ
          </button>
        </div>
        <label>
          速度 (tick/秒)
          <input
            type="number"
            min={1}
            max={500}
            value={ticksPerSecond}
            onChange={(e) => onSetTicksPerSecond(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <p className="mode-indicator">
          モード: {mode === 'live' ? 'ライブ' : 'リプレイ'}
          {gameOver ? '(決着済み)' : ''}
        </p>
      </section>

      <section>
        <h2>マップ / seed</h2>
        <label>
          seed
          <input type="number" value={seedInput} onChange={(e) => setSeedInput(Number(e.target.value))} />
        </label>
        <label>
          mapRadius
          <input
            type="number"
            min={3}
            max={25}
            value={mapRadiusInput}
            onChange={(e) => setMapRadiusInput(Number(e.target.value))}
          />
        </label>
        <label>
          teamCount
          <input
            type="number"
            min={2}
            max={8}
            value={teamCountInput}
            onChange={(e) => setTeamCountInput(Number(e.target.value))}
          />
        </label>
        <label>
          unitsPerTeam
          <input
            type="number"
            min={1}
            max={6}
            value={unitsPerTeamInput}
            onChange={(e) => setUnitsPerTeamInput(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          onClick={() =>
            onReset(seedInput, {
              mapRadius: mapRadiusInput,
              teamCount: teamCountInput,
              unitsPerTeam: unitsPerTeamInput,
            })
          }
        >
          新しいマップで開始
        </button>
      </section>

      <section>
        <h2>チーム別ロジック</h2>
        {Array.from({ length: configForm.teamCount }, (_, teamId) => teamId).map((teamId) => {
          const kind = botAssignment.get(teamId) ?? 'scripted'
          const statusLabel = kind === 'rlBest' || kind === 'rlLatest' ? RL_STATUS_LABEL[rlSlotStatus[kind]] : ''
          return (
            <label key={teamId}>
              <span>
                <span className="team-swatch" style={{ background: teamColor(teamId) }} />
                チーム{teamId}
              </span>
              <select value={kind} onChange={(e) => onSetTeamBot(teamId, e.target.value as TeamLogicKind)}>
                {(Object.keys(BOT_LABEL) as TeamLogicKind[]).map((k) => (
                  <option key={k} value={k}>
                    {BOT_LABEL[k]}
                  </option>
                ))}
              </select>
              {statusLabel && <p className="mode-indicator">{statusLabel}</p>}
            </label>
          )
        })}
      </section>

      <section>
        <h2>リプレイ</h2>
        <button type="button" onClick={onStartReplay} disabled={!canReplay}>
          直前のライブ実行をリプレイ
        </button>
      </section>

      <section>
        <h2>デバッグ表示(選択中ユニットのみ)</h2>
        <label>
          <input type="checkbox" checked={showVision} onChange={onToggleVision} />
          視界範囲
        </label>
        <label>
          <input type="checkbox" checked={showAttackRange} onChange={onToggleAttackRange} />
          攻撃射程
        </label>
        <label>
          <input type="checkbox" checked={showPatch} onChange={onTogglePatch} />
          観測パッチ
        </label>
      </section>
    </div>
  )
}
