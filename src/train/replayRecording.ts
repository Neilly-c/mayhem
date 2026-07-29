import type { SimConfig } from '../sim'
import type { BotKind } from '../agents'
import type { LoggedDecision } from '../app/replay'
import type { ActorCriticModel } from './network'
import { createPolicyDecisionSource } from './policyDecisionSource'
import { BASELINE_BOTS, mergeDecisionSources, playOneEpisode } from './evaluate'

/** `BotKind`(baseline bot)に加えて、全チームがそのチェックポイントのポリシーに従う自己対戦モード。 */
export type ReplayOpponent = BotKind | 'selfPlay'

export interface RecordedReplay {
  iteration: number
  opponentBotKind: ReplayOpponent
  seed: number
  /** `createConfig`で解決済みの完全な設定。再生側(ブラウザ)が同じマップを再構築するのに使う。 */
  simConfig: SimConfig
  log: LoggedDecision[]
  createdAt: string
}

export interface RecordReplayOptions {
  iteration: number
  opponentBotKind: BotKind
  seed: number
  /** モデルが操作するチームID。既定0。 */
  policyTeamId?: number
  maxTicks?: number
}

/**
 * ユーザー要望: 学習の世代を追って見た目の変化を追えるように、決定的(argmax)ポリシー1体分の
 * 対戦を`src/app/replay.ts`の`LoggedDecision[]`形式で記録する。この形式はブラウザ側の
 * `createReplayDecisionSource`でそのまま再生できる — `replay.ts`はDOM/Reactに依存しない
 * 純粋なモジュールなので、Node専用の本パイプラインから直接importして問題ない。
 */
export function recordReplay(model: ActorCriticModel, simConfig: Partial<SimConfig>, options: RecordReplayOptions): RecordedReplay {
  const policyTeamId = options.policyTeamId ?? 0
  const policySource = createPolicyDecisionSource(model, { deterministic: true })
  const merged = mergeDecisionSources(policyTeamId, policySource, BASELINE_BOTS[options.opponentBotKind])

  const log: LoggedDecision[] = []
  const { simConfig: resolvedSimConfig } = playOneEpisode(
    simConfig,
    options.seed,
    policyTeamId,
    merged,
    options.maxTicks ?? 3000,
    log,
  )

  return {
    iteration: options.iteration,
    opponentBotKind: options.opponentBotKind,
    seed: options.seed,
    simConfig: resolvedSimConfig,
    log,
    createdAt: new Date().toISOString(),
  }
}

export interface RecordSelfPlayReplayOptions {
  iteration: number
  seed: number
  maxTicks?: number
}

/**
 * ユーザー要望: baseline botとの対戦(`recordReplay`)ではなく、そのチェックポイント時点の
 * ポリシーに**全チーム**が従った場合の対戦(実際の学習ロールアウトと同じ構成の自己対戦)を
 * そのまま記録する。`policySource`をチーム分けせず全ユニットへそのまま渡すのが違いのすべてで、
 * それ以外(記録形式・決定的argmax行動選択)は`recordReplay`と同じ。
 */
export function recordSelfPlayReplay(
  model: ActorCriticModel,
  simConfig: Partial<SimConfig>,
  options: RecordSelfPlayReplayOptions,
): RecordedReplay {
  const policySource = createPolicyDecisionSource(model, { deterministic: true })

  const log: LoggedDecision[] = []
  // policyTeamId(第3引数)はplayOneEpisode内の順位算出にのみ使われる。全チーム同一方策なので
  // どのIDを渡しても対戦内容自体は変わらない — 慣例通り0を使う。
  const { simConfig: resolvedSimConfig } = playOneEpisode(simConfig, options.seed, 0, policySource, options.maxTicks ?? 3000, log)

  return {
    iteration: options.iteration,
    opponentBotKind: 'selfPlay',
    seed: options.seed,
    simConfig: resolvedSimConfig,
    log,
    createdAt: new Date().toISOString(),
  }
}
