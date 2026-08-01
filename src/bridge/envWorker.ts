/**
 * Node↔Pythonブリッジのワーカーサブプロセス本体(`tsx src/bridge/envWorker.ts`)。
 * env群のシャードを1つ保持し、stdinからNDJSONリクエストを読み、stdoutへNDJSONレスポンスを書く。
 * §0の制約: フォワードパスは一切ここで行わない — ニューラルネットはPython側のみ。
 * stdoutはプロトコルフレーム専用。ログ/エラーはstderrへ。
 */
import type { ActionInput, RewardConfig } from '../env'
import { Env, buildActionMasksForEnv } from '../env'
import type { SimConfig } from '../sim'
import { createConfig, deriveRng, isGameOver, randInt } from '../sim'
import { inferObsDim } from '../train/shapes'
import { curriculumSimConfig } from '../train/curriculum'
import {
  NdjsonDecoder,
  encodeMessage,
  type AgentObservation,
  type BootstrapEntry,
  type BridgeRequest,
  type BridgeResponse,
  type InitPayload,
  type InitResult,
  type ResetPayload,
  type ResetResult,
  type ResolveSimConfigPayload,
  type ResolveSimConfigResult,
  type StepPayload,
  type StepResultEnv,
  type StepResultPayload,
  type StepUnitResult,
} from './protocol'

interface EnvSlot {
  env: Env
  episodeId: number
}

interface WorkerState {
  workerId: number
  baseSeed: number
  simConfigOverrides: Partial<SimConfig>
  rewardConfigOverrides: Partial<RewardConfig> | undefined
  maxTicks: number | undefined
  slots: (EnvSlot | null)[]
}

let state: WorkerState | null = null

function requireState(): WorkerState {
  if (!state) throw new Error('worker received a message before "init"')
  return state
}

function deriveAutoResetSeed(baseSeed: number, workerId: number, localEnvIndex: number, episodeId: number): number {
  const rng = deriveRng(baseSeed, `bridge:worker${workerId}:env${localEnvIndex}:ep${episodeId}`)
  return randInt(rng, 2 ** 31)
}

function toAgentObservations(env: Env, observations: Record<number, { vector: number[]; visibleEnemyIds: number[] }>): AgentObservation[] {
  const masks = buildActionMasksForEnv(env)
  return env.agents.map((unitId) => ({
    unitId,
    observation: observations[unitId].vector,
    visibleEnemyIds: observations[unitId].visibleEnemyIds,
    actionMask: masks[unitId],
  }))
}

function handleInit(payload: InitPayload): InitResult {
  state = {
    workerId: payload.workerId,
    baseSeed: payload.baseSeed,
    simConfigOverrides: payload.simConfigOverrides ?? {},
    rewardConfigOverrides: payload.rewardConfigOverrides ?? undefined,
    // `??`(not just passing payload.maxTicks through) matters here: JSON has no `undefined`, so a
    // Python caller that omits maxTicks sends explicit `null`, which parses to JS `null` rather
    // than `undefined`. `Env`'s truncation check is `this.maxTicks !== undefined`, so a raw
    // `null` would make every unit register as truncated on every single step (`tick >= null`
    // coerces to `tick >= 0`, always true) — this was a real bug caught via the Python smoke run.
    maxTicks: payload.maxTicks ?? undefined,
    slots: new Array(payload.numEnvs).fill(null) as (EnvSlot | null)[],
  }

  const obsDim = inferObsDim(state.simConfigOverrides, 0)
  const resolved = createConfig(state.simConfigOverrides)
  return { obsDim, maxVisibleEnemies: resolved.maxVisibleEnemies, moveActions: 7, abilityActions: 7 }
}

function handleReset(payload: ResetPayload): ResetResult {
  const s = requireState()

  const envs = payload.envs.map(({ localEnvIndex, seed }) => {
    let slot = s.slots[localEnvIndex]
    if (!slot) {
      const env = Env.create(seed, {
        simConfig: s.simConfigOverrides,
        rewardConfig: s.rewardConfigOverrides,
        maxTicks: s.maxTicks,
      })
      slot = { env, episodeId: 0 }
      s.slots[localEnvIndex] = slot
    } else {
      slot.episodeId = 0
    }

    const observations = slot.env.reset(seed)
    return { localEnvIndex, episodeId: slot.episodeId, agents: toAgentObservations(slot.env, observations) }
  })

  return { envs }
}

function handleStep(payload: StepPayload): StepResultPayload {
  const s = requireState()

  const envs: StepResultEnv[] = payload.envs.map(({ localEnvIndex, actions }) => {
    const slot = s.slots[localEnvIndex]
    if (!slot) throw new Error(`step: env ${localEnvIndex} was never reset`)

    const actionMap: Record<number, ActionInput> = {}
    for (const a of actions) actionMap[a.unitId] = { move: a.move, attack: a.attack, ability: a.ability }

    const stepResult = slot.env.step(actionMap)
    const resultEpisodeId = slot.episodeId

    const units: StepUnitResult[] = actions.map((a) => ({
      unitId: a.unitId,
      reward: stepResult.rewards[a.unitId] ?? 0,
      terminated: stepResult.terminations[a.unitId] ?? false,
      truncated: stepResult.truncations[a.unitId] ?? false,
    }))

    // Same three auto-reset conditions as src/train/rolloutBuffer.ts's `needsReset`: no agents
    // left, a decisive win/elimination, or a maxTicks truncation (Env itself never auto-stops).
    const stillAliveAgents = slot.env.agents
    const truncatedThisStep = Object.values(stepResult.truncations).some(Boolean)
    const needsReset = stillAliveAgents.length === 0 || isGameOver(slot.env.state) || truncatedThisStep

    if (!needsReset) {
      const continuing = toAgentObservations(slot.env, stepResult.observations)
      return { localEnvIndex, episodeId: resultEpisodeId, units, continuing, reset: null }
    }

    // Natural episode end (win/elimination/truncation) while some units are still alive — not a
    // real death, so Python needs their final observation to compute a real bootstrap value
    // itself (§0: no forward pass happens here).
    const bootstrap: BootstrapEntry[] = stillAliveAgents.map((unitId) => ({
      unitId,
      observation: stepResult.observations[unitId].vector,
    }))

    slot.episodeId++
    const newSeed = deriveAutoResetSeed(s.baseSeed, s.workerId, localEnvIndex, slot.episodeId)
    const newObservations = slot.env.reset(newSeed)
    const agents = toAgentObservations(slot.env, newObservations)

    return {
      localEnvIndex,
      episodeId: resultEpisodeId,
      units,
      continuing: [],
      reset: { newEpisodeId: slot.episodeId, bootstrap, agents },
    }
  })

  return { envs }
}

function handleResolveSimConfig(payload: ResolveSimConfigPayload): ResolveSimConfigResult {
  return { simConfig: curriculumSimConfig(payload.iteration) }
}

function writeResponse(response: BridgeResponse): void {
  process.stdout.write(encodeMessage(response))
}

function handleMessage(message: BridgeRequest): void {
  if (message.type === 'shutdown') {
    writeResponse({ id: message.id, ok: true, result: {} })
    process.stdout.end(() => process.exit(0))
    return
  }

  try {
    switch (message.type) {
      case 'init':
        writeResponse({ id: message.id, ok: true, result: handleInit(message.payload) })
        return
      case 'reset':
        writeResponse({ id: message.id, ok: true, result: handleReset(message.payload) })
        return
      case 'step':
        writeResponse({ id: message.id, ok: true, result: handleStep(message.payload) })
        return
      case 'resolveSimConfig':
        writeResponse({ id: message.id, ok: true, result: handleResolveSimConfig(message.payload) })
        return
    }
  } catch (err) {
    writeResponse({
      id: message.id,
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    })
  }
}

const decoder = new NdjsonDecoder()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  for (const raw of decoder.push(chunk)) {
    handleMessage(raw as BridgeRequest)
  }
})
process.stdin.on('end', () => process.exit(0))
