import * as tf from '@tensorflow/tfjs'
import type { ActionInput, ActionMask, Observation, StepResult } from '../env'
import { Env, buildActionMasksForEnv } from '../env'
import { deriveRng, isGameOver, randInt } from '../sim'
import type { ActorCriticModel } from './network'
import { sampleMaskedCategorical } from './actionSampling'
import { computeGAE } from './gae'
import type { RolloutBatch, RolloutStep } from './types'

/**
 * 複数の`Env`インスタンスをロックステップで駆動する永続状態(バッチ化・単一プロセス内 —
 * 実スレッドではない。`Env`自身が「並べて多数生成できる」ことを前提に設計されている §1)。
 * `collectRollout`を反復呼び出しする間、各envの「現在のエピソード」を跨いで保持する
 * (呼び出しごとに全envをリセットすると、直前のロールアウトの続きからではなく
 * 常にエピソード冒頭からしかデータを取れなくなってしまう)。
 */
export interface RolloutState {
  envs: Env[]
  /** env毎の、リセットのたびに1ずつ増えるカウンタ。ユニットIDはリセットのたびに再利用される
   * ため(entities.tsが毎回0から振り直す)、セグメントを`(envIndex, episodeId, unitId)`で
   * 一意化するのに使う。 */
  episodeIds: number[]
  /** env毎の、現在アクティブなエージェントに対する直近の観測。 */
  obs: Record<number, Observation>[]
  /** env毎の、現在アクティブなエージェントに対する直近の行動マスク。 */
  masks: Record<number, ActionMask>[]
}

function deriveEnvSeed(baseSeed: number, envIndex: number, episodeId: number): number {
  const rng = deriveRng(baseSeed, `rollout:env${envIndex}:ep${episodeId}`)
  return randInt(rng, 2 ** 31)
}

export function createRolloutState(envs: Env[], baseSeed: number): RolloutState {
  const episodeIds = envs.map(() => 0)
  const obs: Record<number, Observation>[] = []
  const masks: Record<number, ActionMask>[] = []
  envs.forEach((env, i) => {
    obs.push(env.reset(deriveEnvSeed(baseSeed, i, 0)))
    masks.push(buildActionMasksForEnv(env))
  })
  return { envs, episodeIds, obs, masks }
}

interface RawRecord {
  envIndex: number
  episodeId: number
  unitId: number
  obs: number[]
  moveMask: boolean[]
  attackMask: boolean[]
  moveAction: number
  attackAction: number
  oldLogProb: number
  value: number
  reward: number
  /** Envの`terminations[unitId]`(本当に死んだか)。打ち切り/ロールアウト末端での継続中はfalse。 */
  terminated: boolean
}

function segmentKey(envIndex: number, episodeId: number, unitId: number): string {
  return `${envIndex}:${episodeId}:${unitId}`
}

function computeBootstrapValues(
  model: ActorCriticModel,
  obsByUnit: Record<number, Observation>,
  unitIds: number[],
): number[] {
  if (unitIds.length === 0) return []
  return tf.tidy(() => {
    const obsT = tf.tensor2d(unitIds.map((id) => obsByUnit[id].vector))
    const { value } = model.forward(obsT)
    return Array.from(value.dataSync())
  })
}

export interface CollectRolloutOptions {
  rolloutLength: number
  gamma: number
  lambda: number
  /** env自動リセットのseed導出に使う基点。呼び出しごとに変える必要はない —
   * `episodeIds`が呼び出しを跨いで単調増加し続けるため、同じ`baseSeed`でも
   * リセットのたびに異なるseedが導出される。 */
  baseSeed: number
}

/**
 * `rolloutLength`意思決定ステップ分、全envをロックステップで進めてデータを収集する。
 * 各意思決定ステップで、全envの現在アクティブな`(env,unit)`ペアを1つのバッチにまとめて
 * 1回の`model.forward`で処理する(§1の「複数環境インスタンスを同一プロセスで並列生成」を
 * バッチ化フォワードパスとして実現)。envが空になる/ゲーム終了したら即座にリセットし、
 * 収集が滞らないようにする。
 */
export function collectRollout(
  state: RolloutState,
  model: ActorCriticModel,
  opts: CollectRolloutOptions,
): RolloutBatch {
  const { envs, episodeIds, obs, masks } = state
  const numEnvs = envs.length

  const records: RawRecord[] = []
  const bootstrapValues = new Map<string, number>()
  const episodeReturnAccum: Map<number, number>[] = Array.from({ length: numEnvs }, () => new Map())
  const episodeReturns: number[] = []

  for (let step = 0; step < opts.rolloutLength; step++) {
    const active: { envIndex: number; unitId: number }[] = []
    const obsRows: number[][] = []
    const moveMaskRows: number[][] = []
    const attackMaskRows: number[][] = []

    for (let e = 0; e < numEnvs; e++) {
      for (const unitId of envs[e].agents) {
        const o = obs[e][unitId]
        const m = masks[e][unitId]
        if (!o || !m) continue
        active.push({ envIndex: e, unitId })
        obsRows.push(o.vector)
        moveMaskRows.push(m.move.map((b) => (b ? 1 : 0)))
        attackMaskRows.push(m.attack.map((b) => (b ? 1 : 0)))
      }
    }
    if (active.length === 0) break // shouldn't happen given per-step auto-reset below; defensive only

    const { moveActions, attackActions, oldLogProbs, values } = tf.tidy(() => {
      const obsT = tf.tensor2d(obsRows)
      const moveMaskT = tf.tensor2d(moveMaskRows)
      const attackMaskT = tf.tensor2d(attackMaskRows)
      const { moveLogits, attackLogits, value } = model.forward(obsT)
      const moveSample = sampleMaskedCategorical(moveLogits, moveMaskT)
      const attackSample = sampleMaskedCategorical(attackLogits, attackMaskT)
      const jointLogProb = tf.add(moveSample.logProbs, attackSample.logProbs)
      return {
        moveActions: Array.from(moveSample.actions.dataSync()),
        attackActions: Array.from(attackSample.actions.dataSync()),
        oldLogProbs: Array.from(jointLogProb.dataSync()),
        values: Array.from(value.reshape([value.shape[0]]).dataSync()),
      }
    })

    const perEnvActions: Record<number, ActionInput>[] = Array.from({ length: numEnvs }, () => ({}))
    active.forEach((a, i) => {
      perEnvActions[a.envIndex][a.unitId] = { move: moveActions[i], attack: attackActions[i] }
    })

    const stepResults: StepResult[] = envs.map((env, e) => env.step(perEnvActions[e]))

    active.forEach((a, i) => {
      const sr = stepResults[a.envIndex]
      const reward = sr.rewards[a.unitId] ?? 0
      const terminated = sr.terminations[a.unitId] ?? false
      records.push({
        envIndex: a.envIndex,
        episodeId: episodeIds[a.envIndex],
        unitId: a.unitId,
        obs: obsRows[i],
        moveMask: moveMaskRows[i].map((v) => v === 1),
        attackMask: attackMaskRows[i].map((v) => v === 1),
        moveAction: moveActions[i],
        attackAction: attackActions[i],
        oldLogProb: oldLogProbs[i],
        value: values[i],
        reward,
        terminated,
      })
      const accum = episodeReturnAccum[a.envIndex]
      accum.set(a.unitId, (accum.get(a.unitId) ?? 0) + reward)
    })

    for (let e = 0; e < numEnvs; e++) {
      const sr = stepResults[e]
      const postStepObs = sr.observations
      const postStepMasks: Record<number, ActionMask> = {}
      for (const [unitIdStr, info] of Object.entries(sr.infos)) {
        postStepMasks[Number(unitIdStr)] = info.actionMask
      }

      const stillAliveAgents = envs[e].agents // reflects state after env.step() above
      // `maxTicks`truncation only sets per-unit `truncations` flags (Env itself never auto-stops);
      // without also treating that as a reset trigger here, an `EnvOptions.maxTicks` cap would be
      // silently ignored and episodes could run indefinitely past it.
      const truncatedThisStep = Object.values(sr.truncations).some(Boolean)
      const needsReset = stillAliveAgents.length === 0 || isGameOver(envs[e].state) || truncatedThisStep

      if (needsReset && stillAliveAgents.length > 0) {
        // Natural episode end (win/elimination/truncation) while these units are still alive —
        // not a real death, so they need a real bootstrap value, computed now before their
        // observations become unreachable (the env is about to reset to a brand-new episode).
        const bootVals = computeBootstrapValues(model, postStepObs, stillAliveAgents)
        stillAliveAgents.forEach((unitId, idx) => {
          bootstrapValues.set(segmentKey(e, episodeIds[e], unitId), bootVals[idx])
        })
      }

      if (needsReset) {
        episodeReturns.push(...episodeReturnAccum[e].values())
        episodeReturnAccum[e] = new Map()
        episodeIds[e]++
        obs[e] = envs[e].reset(deriveEnvSeed(opts.baseSeed, e, episodeIds[e]))
        masks[e] = buildActionMasksForEnv(envs[e])
      } else {
        obs[e] = postStepObs
        masks[e] = postStepMasks
      }
    }
  }

  // Rollout window ended while some units are still mid-life (never terminated, never hit a
  // mid-rollout reset) — bootstrap them too, using the same map, so every open segment resolves.
  for (let e = 0; e < numEnvs; e++) {
    const aliveNow = envs[e].agents
    if (aliveNow.length === 0) continue
    const bootVals = computeBootstrapValues(model, obs[e], aliveNow)
    aliveNow.forEach((unitId, idx) => {
      bootstrapValues.set(segmentKey(e, episodeIds[e], unitId), bootVals[idx])
    })
  }

  const grouped = new Map<string, RawRecord[]>()
  for (const r of records) {
    const key = segmentKey(r.envIndex, r.episodeId, r.unitId)
    const arr = grouped.get(key)
    if (arr) arr.push(r)
    else grouped.set(key, [r])
  }

  const steps: RolloutStep[] = []
  for (const [key, recs] of grouped) {
    const terminal = recs[recs.length - 1].terminated
    const bootstrapValue = terminal ? 0 : (bootstrapValues.get(key) ?? 0)
    const { advantages, returns } = computeGAE(
      { rewards: recs.map((r) => r.reward), values: recs.map((r) => r.value), bootstrapValue, terminal },
      opts.gamma,
      opts.lambda,
    )
    recs.forEach((r, i) => {
      steps.push({
        obs: r.obs,
        moveMask: r.moveMask,
        attackMask: r.attackMask,
        moveAction: r.moveAction,
        attackAction: r.attackAction,
        oldLogProb: r.oldLogProb,
        value: r.value,
        advantage: advantages[i],
        return: returns[i],
      })
    })
  }

  return { steps, episodeReturns }
}
