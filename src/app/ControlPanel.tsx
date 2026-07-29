import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  Grid3x3,
  Mountain,
  Pause,
  Play,
  RotateCcw,
  StepForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { defaultBotKindForTeam } from '../agents'
import { teamColor } from '../render'
import { isMuted, playClick, playHover, setMuted } from './sound'
import type { PlaybackMode, RlSlot, RlSlotStatus, SimulationFormConfig, TeamLogicKind } from './useSimulationLoop'

const BOT_LABEL: Record<TeamLogicKind, string> = {
  expander: '拡張型',
  guardian: '防衛型',
  raider: '攻撃型',
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
  obliqueView: boolean
  onToggleVision: () => void
  onToggleAttackRange: () => void
  onTogglePatch: () => void
  onToggleObliqueView: () => void
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
  obliqueView,
  onToggleVision,
  onToggleAttackRange,
  onTogglePatch,
  onToggleObliqueView,
}: Props) {
  const [seedInput, setSeedInput] = useState(seed)
  const [mapRadiusInput, setMapRadiusInput] = useState(configForm.mapRadius)
  const [teamCountInput, setTeamCountInput] = useState(configForm.teamCount)
  const [unitsPerTeamInput, setUnitsPerTeamInput] = useState(configForm.unitsPerTeam)
  const [teamLogicExpanded, setTeamLogicExpanded] = useState(false)
  const [muted, setMutedState] = useState(isMuted())

  /** ユーザー要望: ボタンのhover/clickにSEを付ける。全ボタン共通でこの2つをラップして使う。 */
  const withClick = (fn: () => void) => () => {
    playClick()
    fn()
  }

  return (
    <div className="control-panel">
      <section>
        <h2>再生</h2>
        <div className="button-row">
          <button
            type="button"
            className="icon-button"
            onClick={withClick(playing ? onPause : onPlay)}
            onMouseEnter={playHover}
            title={playing ? '停止' : '再生'}
            aria-label={playing ? '停止' : '再生'}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={withClick(onStepOnce)}
            onMouseEnter={playHover}
            disabled={playing}
            title="1tickステップ"
            aria-label="1tickステップ"
          >
            <StepForward size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={withClick(onStartReplay)}
            onMouseEnter={playHover}
            disabled={!canReplay}
            title="直前のライブ実行をリプレイ"
            aria-label="直前のライブ実行をリプレイ"
          >
            <RotateCcw size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              const next = !muted
              setMuted(next)
              setMutedState(next)
              playClick()
            }}
            onMouseEnter={playHover}
            title={muted ? 'ミュート中(クリックで解除)' : 'SEを鳴らす(クリックでミュート)'}
            aria-label={muted ? 'ミュート解除' : 'ミュート'}
            aria-pressed={muted}
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
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
          <input
            type="number"
            value={seedInput}
            disabled={playing}
            onChange={(e) => {
              const nextSeed = Number(e.target.value)
              setSeedInput(nextSeed)
              onReset(nextSeed, configForm)
            }}
          />
        </label>
        <label>
          mapRadius
          <input
            type="number"
            min={3}
            max={25}
            value={mapRadiusInput}
            disabled={playing}
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
            disabled={playing}
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
            disabled={playing}
            onChange={(e) => setUnitsPerTeamInput(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={playing}
          onClick={withClick(() =>
            onReset(seedInput, {
              mapRadius: mapRadiusInput,
              teamCount: teamCountInput,
              unitsPerTeam: unitsPerTeamInput,
            }),
          )}
          onMouseEnter={playHover}
        >
          新しいマップで開始
        </button>
      </section>

      <section>
        <button
          type="button"
          className="section-toggle"
          onClick={withClick(() => setTeamLogicExpanded((v) => !v))}
          onMouseEnter={playHover}
          aria-expanded={teamLogicExpanded}
        >
          {teamLogicExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <h2>チーム別ロジック</h2>
        </button>
        {teamLogicExpanded &&
          Array.from({ length: configForm.teamCount }, (_, teamId) => teamId).map((teamId) => {
            const kind = botAssignment.get(teamId) ?? defaultBotKindForTeam(teamId)
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
        <h2>デバッグ表示(選択中ユニットのみ)</h2>
        <div className="button-row">
          <button
            type="button"
            className={`icon-button toggle${showVision ? ' toggle-on' : ''}`}
            onClick={withClick(onToggleVision)}
            onMouseEnter={playHover}
            title="視界範囲"
            aria-label="視界範囲"
            aria-pressed={showVision}
          >
            <Eye size={18} />
          </button>
          <button
            type="button"
            className={`icon-button toggle${showAttackRange ? ' toggle-on' : ''}`}
            onClick={withClick(onToggleAttackRange)}
            onMouseEnter={playHover}
            title="攻撃射程"
            aria-label="攻撃射程"
            aria-pressed={showAttackRange}
          >
            <Crosshair size={18} />
          </button>
          <button
            type="button"
            className={`icon-button toggle${showPatch ? ' toggle-on' : ''}`}
            onClick={withClick(onTogglePatch)}
            onMouseEnter={playHover}
            title="観測パッチ"
            aria-label="観測パッチ"
            aria-pressed={showPatch}
          >
            <Grid3x3 size={18} />
          </button>
          <button
            type="button"
            className={`icon-button toggle${obliqueView ? ' toggle-on' : ''}`}
            onClick={withClick(onToggleObliqueView)}
            onMouseEnter={playHover}
            title="斜め見下ろし(標高表示)"
            aria-label="斜め見下ろし(標高表示)"
            aria-pressed={obliqueView}
          >
            <Mountain size={18} />
          </button>
        </div>
      </section>
    </div>
  )
}
