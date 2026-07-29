import { useCallback, useEffect, useRef, useState } from 'react'
import type * as tf from '@tensorflow/tfjs'
import type { GameState, SimConfig, TickEvents } from '../sim'
import { Simulation, isGameOver } from '../sim'
import type { BotKind, UnitDecision } from '../agents'
import { createTeamRoutedDecisionSource } from '../agents'
import {
  createReplayDecisionSource,
  decisionsToLogEntry,
  type DecisionSource,
  type LoggedDecision,
} from './replay'
import {
  createBrowserPolicyDecisionSource,
  fetchCheckpointManifest,
  loadPolicyModel,
  pickBestCheckpoint,
  pickLatestCheckpoint,
} from './policyModel'
import { playGameOver, playHit, playKill, playRingShrink, playRingWarn } from './sound'

export interface SimulationFormConfig {
  mapRadius: number
  teamCount: number
  unitsPerTeam: number
}

/** ユーザー要望: チーム別ロジックの選択肢に、学習中のRLチェックポイント(最良/最新)を追加する。
 * `BotKind`(訓練パイプライン側でも使う閉じたunion)は変えず、UI側だけでこの2値を上乗せする。 */
export type RlSlot = 'rlBest' | 'rlLatest'
export type TeamLogicKind = BotKind | RlSlot
export type RlSlotStatus = 'idle' | 'loading' | 'loaded' | 'error'

function isRlSlot(kind: TeamLogicKind): kind is RlSlot {
  return kind === 'rlBest' || kind === 'rlLatest'
}

/** `botAssignment`をチームIDの割り当てに沿ってbot駆動分とRLモデル駆動分に振り分け、それぞれの
 * `DecisionSource`へ委譲してから1つの`Map`にまとめる(`evaluate.ts`の2択専用`mergeDecisionSources`
 * のN択版)。RL選択中でもモデル未ロード/読込失敗の間は既定bot(チームNo. mod n)へフォールバックする。 */
function createRoutedDecisionSource(
  assignment: Map<number, TeamLogicKind>,
  rlSources: Partial<Record<RlSlot, DecisionSource>>,
): DecisionSource {
  const botAssignment = new Map<number, BotKind>()
  for (const [teamId, kind] of assignment) {
    if (!isRlSlot(kind)) botAssignment.set(teamId, kind)
  }
  const botSource = createTeamRoutedDecisionSource(botAssignment)

  return (state, unitIds) => {
    const botIds: number[] = []
    const rlIds: Record<RlSlot, number[]> = { rlBest: [], rlLatest: [] }

    for (const unitId of unitIds) {
      const unit = state.units.find((u) => u.id === unitId)
      const kind = unit ? assignment.get(unit.teamId) : undefined
      if (kind && isRlSlot(kind) && rlSources[kind]) {
        rlIds[kind].push(unitId)
      } else {
        botIds.push(unitId)
      }
    }

    const merged = new Map<number, UnitDecision>()
    for (const [unitId, decision] of botSource(state, botIds)) merged.set(unitId, decision)
    for (const slot of ['rlBest', 'rlLatest'] as const) {
      const source = rlSources[slot]
      if (!source || rlIds[slot].length === 0) continue
      for (const [unitId, decision] of source(state, rlIds[slot])) merged.set(unitId, decision)
    }
    return merged
  }
}

export type PlaybackMode = 'live' | 'replay'

interface Driver {
  sim: Simulation
  decisionSource: DecisionSource
  /** null while in live mode (still being recorded); set once replaying a captured run. */
  log: LoggedDecision[] | null
}

function stepOnceWithDecisions(
  driver: Driver,
  onDecision?: (entry: LoggedDecision) => void,
  onTickEvents?: (events: TickEvents) => void,
): void {
  const { sim, decisionSource } = driver
  if (sim.state.tick % sim.state.config.decisionInterval === 0) {
    const aliveIds = sim.state.units.filter((u) => u.alive).map((u) => u.id)
    const decisions = decisionSource(sim.state, aliveIds)
    for (const [unitId, { command, attackTarget }] of decisions) {
      sim.setCommand(unitId, command)
      sim.setAttackTarget(unitId, attackTarget)
    }
    onDecision?.(decisionsToLogEntry(sim.state.tick, decisions))
  }
  const events = sim.step()
  onTickEvents?.(events)
}

const MAX_TICKS_PER_FRAME = 2000

const DEFAULT_SEED = 1
const DEFAULT_FORM_CONFIG: SimulationFormConfig = { mapRadius: 15, teamCount: 6, unitsPerTeam: 3 }

function buildSimConfig(form: SimulationFormConfig): Partial<SimConfig> {
  return { mapRadius: form.mapRadius, teamCount: form.teamCount, unitsPerTeam: form.unitsPerTeam }
}

function createDriver(seed: number, form: SimulationFormConfig): Driver {
  return {
    sim: Simulation.create(seed, buildSimConfig(form)),
    decisionSource: createTeamRoutedDecisionSource(new Map()),
    log: null,
  }
}

/**
 * `tick`はrAFフレームごとに高々1回しか更新されない(1フレームで何tick進めても更新は1回)ため、
 * これをそのまま再描画のトリガーとして使える。描画専用のimperativeなコールバックは不要。
 */
export function useSimulationLoop() {
  const [seed, setSeed] = useState(DEFAULT_SEED)
  const [configForm, setConfigForm] = useState<SimulationFormConfig>(DEFAULT_FORM_CONFIG)
  const [playing, setPlaying] = useState(false)
  const [ticksPerSecond, setTicksPerSecond] = useState(30)
  const [mode, setMode] = useState<PlaybackMode>('live')
  const [tick, setTick] = useState(0)
  const [gameOver, setGameOver] = useState(false)
  const [selectedUnitId, setSelectedUnitId] = useState<number | null>(null)
  const [canReplay, setCanReplay] = useState(false)
  // チーム(teamId)ごとにどのbot/RLモデルへ意思決定を委ねるか。未割り当てのチームはDEFAULT_BOT。
  const [botAssignment, setBotAssignment] = useState<Map<number, TeamLogicKind>>(new Map())
  const [rlSlotStatus, setRlSlotStatus] = useState<Record<RlSlot, RlSlotStatus>>({ rlBest: 'idle', rlLatest: 'idle' })
  const rlModelsRef = useRef<Partial<Record<RlSlot, tf.LayersModel>>>({})
  const [rlModelVersion, setRlModelVersion] = useState(0)
  // Bumped on every reset()/startReplay(), independent of `tick`. A fresh Simulation always means
  // a new map, but `tick` resets to 0 each time and a reset from an already-tick-0 state (e.g. the
  // very first "start with new map" click before ever pressing play/step) wouldn't otherwise change
  // any value SimulationCanvas depends on, so its redraw effect would silently skip.
  const [episode, setEpisode] = useState(0)

  // useState's lazy initializer is guaranteed to run exactly once, which is what seeds the
  // mutable ref below without ever assigning `ref.current` during render.
  const [initialDriver] = useState<Driver>(() => createDriver(DEFAULT_SEED, DEFAULT_FORM_CONFIG))
  const driverRef = useRef<Driver>(initialDriver)
  const logRef = useRef<LoggedDecision[]>([])
  const lastSeedConfigRef = useRef<{ seed: number; config: Partial<SimConfig> }>({
    seed: DEFAULT_SEED,
    config: buildSimConfig(DEFAULT_FORM_CONFIG),
  })
  // ユーザー要望: リング予告/収縮開始・ゲーム終了のSEは「状態が変化した瞬間」だけ鳴らすため、
  // 直前tickの値をrefで保持して比較する。エピソードが変わるたびリセットする(前エピソードの
  // phase/決着状態を引きずって、新エピソード開始直後に誤発火/無発火しないように)。
  const prevRingPhaseRef = useRef<GameState['ring']['phase'] | null>(null)
  const prevGameOverRef = useRef(false)

  const handleTickEvents = useCallback((events: TickEvents) => {
    const driver = driverRef.current
    if (!driver) return
    if (events.combat.length > 0) playHit()
    if (events.deaths.length > 0) playKill()

    const phase = driver.sim.state.ring.phase
    if (phase !== prevRingPhaseRef.current) {
      if (phase === 'warn') playRingWarn()
      else if (phase === 'shrink') playRingShrink()
      prevRingPhaseRef.current = phase
    }

    const over = isGameOver(driver.sim.state)
    if (over && !prevGameOverRef.current) playGameOver()
    prevGameOverRef.current = over
  }, [])

  const reset = useCallback((nextSeed: number, form: SimulationFormConfig) => {
    const simConfig = buildSimConfig(form)
    driverRef.current = {
      sim: Simulation.create(nextSeed, simConfig),
      decisionSource: createTeamRoutedDecisionSource(new Map()),
      log: null,
    }
    logRef.current = []
    lastSeedConfigRef.current = { seed: nextSeed, config: simConfig }
    prevRingPhaseRef.current = null
    prevGameOverRef.current = false
    setSeed(nextSeed)
    setConfigForm(form)
    setMode('live')
    setTick(0)
    setGameOver(false)
    setSelectedUnitId(null)
    setCanReplay(false)
    setBotAssignment(new Map())
    setEpisode((e) => e + 1)
  }, [])

  // 割り当てにRLチェックポイント(最良/最新)が選ばれたら、対応するモデルを読み込む。
  // `rlModelsRef`はセッション内でロード済みのモデルを使い回すキャッシュ(チームを一旦scriptedに
  // 戻してまたRLへ戻しても再取得しない) — ページ再読み込みで最新のチェックポイントに更新される。
  useEffect(() => {
    if (mode !== 'live') return
    const neededSlots = new Set<RlSlot>()
    for (const kind of botAssignment.values()) {
      if (isRlSlot(kind) && !rlModelsRef.current[kind]) neededSlots.add(kind)
    }
    if (neededSlots.size === 0) return

    let cancelled = false
    for (const slot of neededSlots) {
      void (async () => {
        setRlSlotStatus((prev) => ({ ...prev, [slot]: 'loading' }))
        try {
          const checkpoints = await fetchCheckpointManifest()
          const info = slot === 'rlBest' ? pickBestCheckpoint(checkpoints) : pickLatestCheckpoint(checkpoints)
          if (!info) throw new Error('no checkpoint available')
          const model = await loadPolicyModel(info.dir)
          if (cancelled) {
            model.dispose()
            return
          }
          rlModelsRef.current[slot] = model
          setRlSlotStatus((prev) => ({ ...prev, [slot]: 'loaded' }))
          setRlModelVersion((v) => v + 1)
        } catch {
          if (!cancelled) setRlSlotStatus((prev) => ({ ...prev, [slot]: 'error' }))
        }
      })()
    }
    return () => {
      cancelled = true
    }
  }, [botAssignment, mode])

  // ライブ実行中のみ、割り当て/ロード済みRLモデルが変わるたびにdriverの意思決定元を差し替える
  // (リプレイ中はcreateReplayDecisionSourceのままにしておき、記録済みログの再現を妨げない)。
  useEffect(() => {
    if (mode !== 'live') return
    const driver = driverRef.current
    if (!driver) return
    const rlSources: Partial<Record<RlSlot, DecisionSource>> = {}
    if (rlModelsRef.current.rlBest) rlSources.rlBest = createBrowserPolicyDecisionSource(rlModelsRef.current.rlBest)
    if (rlModelsRef.current.rlLatest) rlSources.rlLatest = createBrowserPolicyDecisionSource(rlModelsRef.current.rlLatest)
    driver.decisionSource = createRoutedDecisionSource(botAssignment, rlSources)
  }, [botAssignment, mode, rlModelVersion])

  const setTeamBot = useCallback((teamId: number, kind: TeamLogicKind) => {
    setBotAssignment((prev) => {
      const next = new Map(prev)
      next.set(teamId, kind)
      return next
    })
  }, [])

  const stepOnce = useCallback(() => {
    const driver = driverRef.current
    if (!driver) return
    stepOnceWithDecisions(
      driver,
      (entry) => {
        if (driver.log === null) logRef.current.push(entry)
      },
      handleTickEvents,
    )
    setTick(driver.sim.state.tick)
    setGameOver(isGameOver(driver.sim.state))
    if (driver.log === null && logRef.current.length > 0) setCanReplay(true)
  }, [handleTickEvents])

  const play = useCallback(() => setPlaying(true), [])
  const pause = useCallback(() => setPlaying(false), [])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let lastTime = performance.now()
    let accumulatedMs = 0

    const loop = (now: number) => {
      const driver = driverRef.current
      if (driver) {
        accumulatedMs += now - lastTime
        lastTime = now
        const msPerTick = 1000 / ticksPerSecond
        let ticksToRun = Math.min(MAX_TICKS_PER_FRAME, Math.floor(accumulatedMs / msPerTick))
        accumulatedMs -= ticksToRun * msPerTick

        // ユーザー要望: 陣営の目的はマップ占領率。残り1チームでも自由に塗り続けられるため、
        // 全チームのユニットが全滅した時点(`isGameOver`, リングダメージによる最終的な全滅)で
        // シミュレーションを止める(自動一時停止)。
        let over = isGameOver(driver.sim.state)
        while (!over && ticksToRun-- > 0) {
          stepOnceWithDecisions(
            driver,
            (entry) => {
              if (driver.log === null) logRef.current.push(entry)
            },
            handleTickEvents,
          )
          over = isGameOver(driver.sim.state)
        }
        setTick(driver.sim.state.tick)
        setGameOver(over)
        if (driver.log === null && logRef.current.length > 0) setCanReplay(true)

        if (over) {
          setPlaying(false)
          return
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, ticksPerSecond, handleTickEvents])

  const startReplay = useCallback(() => {
    const { seed: replaySeed, config } = lastSeedConfigRef.current
    const log = logRef.current.slice()
    driverRef.current = {
      sim: Simulation.create(replaySeed, config),
      decisionSource: createReplayDecisionSource(log),
      log,
    }
    prevRingPhaseRef.current = null
    prevGameOverRef.current = false
    setMode('replay')
    setTick(0)
    setGameOver(false)
    setPlaying(false)
    setEpisode((e) => e + 1)
  }, [])

  /**
   * ユーザー要望: 学習パイプライン(`src/train/trainPPO.ts`)が書き出した外部のリプレイ
   * (seed・完全な`SimConfig`・`LoggedDecision[]`)を読み込んで即座に再生する。読み込んだ瞬間に
   * 再生を始める(`startReplay`と違い`setPlaying(true)`) — 「クリックで再生できるように」という
   * 要望に沿うため、読み込みと再生開始を1操作にまとめている。
   */
  const loadReplay = useCallback((replaySeed: number, config: Partial<SimConfig>, log: LoggedDecision[]) => {
    driverRef.current = {
      sim: Simulation.create(replaySeed, config),
      decisionSource: createReplayDecisionSource(log),
      log,
    }
    prevRingPhaseRef.current = null
    prevGameOverRef.current = false
    setMode('replay')
    setTick(0)
    setGameOver(false)
    setSelectedUnitId(null)
    setPlaying(true)
    setEpisode((e) => e + 1)
  }, [])

  const getState = useCallback((): GameState => {
    if (!driverRef.current) throw new Error('Simulation not initialized')
    return driverRef.current.sim.state
  }, [])

  return {
    getState,
    tick,
    episode,
    gameOver,
    playing,
    ticksPerSecond,
    mode,
    seed,
    configForm,
    selectedUnitId,
    canReplay,
    botAssignment,
    rlSlotStatus,
    play,
    pause,
    stepOnce,
    setTicksPerSecond,
    reset,
    startReplay,
    loadReplay,
    selectUnit: setSelectedUnitId,
    setTeamBot,
  }
}
