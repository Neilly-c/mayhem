import type { SimConfig } from '../sim'
import { Simulation, deriveRng, getRanking, getWinnerTeamId, isGameOver, randInt } from '../sim'
import type { BotKind, DecisionSource, UnitDecision } from '../agents'
import { decideDecisionTreeCommands, decideScriptedBotCommands, decideSurvivalCommands } from '../agents'
import { decisionsToLogEntry, type LoggedDecision } from '../app/replay'
import type { ActorCriticModel } from './network'
import { createPolicyDecisionSource } from './policyDecisionSource'
import type { EvalMatchup, EvalReport } from './types'

/** `src/agents`の各bot実装をそのまま対戦相手として使う。`BotKind`は閉じたunionなので
 * `replayRecording.ts`もこのマップを再利用する。 */
export const BASELINE_BOTS: Record<BotKind, DecisionSource> = {
  scripted: decideScriptedBotCommands,
  decisionTree: decideDecisionTreeCommands,
  survival: decideSurvivalCommands,
}

/** `policyTeamId`のユニットは`policySource`、それ以外全チームは`opponentSource`に振り分ける。
 * `createTeamRoutedDecisionSource`(agents/teamAssignment.ts)を使わないのは、その`BotKind`が
 * 閉じたunionでポリシーを含められないため — ここでは単純な2分岐だけなので手書きの方が軽い。
 * `replayRecording.ts`もこの関数を再利用する。 */
export function mergeDecisionSources(
  policyTeamId: number,
  policySource: DecisionSource,
  opponentSource: DecisionSource,
): DecisionSource {
  return (state, unitIds) => {
    const policyIds: number[] = []
    const opponentIds: number[] = []
    for (const id of unitIds) {
      const unit = state.units.find((u) => u.id === id)
      if (unit?.teamId === policyTeamId) policyIds.push(id)
      else opponentIds.push(id)
    }
    const merged = new Map<number, UnitDecision>()
    for (const [id, d] of policySource(state, policyIds)) merged.set(id, d)
    for (const [id, d] of opponentSource(state, opponentIds)) merged.set(id, d)
    return merged
  }
}

function deriveEpisodeSeed(baseSeed: number, opponentBotKind: BotKind, episodeIndex: number): number {
  const rng = deriveRng(baseSeed, `eval:${opponentBotKind}:${episodeIndex}`)
  return randInt(rng, 2 ** 31)
}

/**
 * `useSimulationLoop.ts`のライブ実行ループと同じ「decisionIntervalごとに指令を更新してstep」パターン。
 * 報酬は無関係なので`Env`ではなく`Simulation`を直接駆動する(§9の勝敗判定をそのまま使う)。
 * `recordedLog`を渡すと、ブラウザ側の`createReplayDecisionSource`(`src/app/replay.ts`)でそのまま
 * 再生できる形式の意思決定ログを蓄積する(`replayRecording.ts`が使う)。返す`simConfig`は
 * `createConfig`で解決済みの完全な設定 — 再生側が同じマップを再構築するのに必要。
 */
export function playOneEpisode(
  simConfig: Partial<SimConfig>,
  seed: number,
  policyTeamId: number,
  decisionSource: DecisionSource,
  maxTicks: number,
  recordedLog?: LoggedDecision[],
): { rank: number; winnerTeamId: number | null; simConfig: SimConfig } {
  const sim = Simulation.create(seed, simConfig)

  while (!isGameOver(sim.state) && sim.state.tick < maxTicks) {
    if (sim.state.tick % sim.state.config.decisionInterval === 0) {
      const aliveIds = sim.state.units.filter((u) => u.alive).map((u) => u.id)
      const decisions = decisionSource(sim.state, aliveIds)
      for (const [unitId, { command, attackTarget }] of decisions) {
        sim.setCommand(unitId, command)
        sim.setAttackTarget(unitId, attackTarget)
      }
      recordedLog?.push(decisionsToLogEntry(sim.state.tick, decisions))
    }
    sim.step()
  }

  const ranking = getRanking(sim.state)
  return { rank: ranking.indexOf(policyTeamId), winnerTeamId: getWinnerTeamId(sim.state), simConfig: sim.state.config }
}

export interface EvalOptions {
  iteration: number
  matchups: { opponentBotKind: BotKind; episodes: number }[]
  seedBase: number
  /** モデルが操作するチームID。既定0。 */
  policyTeamId?: number
  /** リングが強制的に決着させる保証はあるが(§9)、念のための安全弁。既定3000。 */
  maxTicksPerEpisode?: number
}

/**
 * 学習済みポリシーを既存の各baseline bot(`scripted`/`decisionTree`/`survival`)と対戦させ、
 * 勝率・平均順位を報告する。報酬整形を経た`episodeReturn`は解釈しづらいので、進捗の実質的な
 * シグナルはこちら。ポリシーは常に決定的(argmax)行動で評価する(§11.4「報酬は最初は疎な順位
 * 報酬中心に」の実質的な検証instrument)。
 */
export function evaluateAgainstBots(
  model: ActorCriticModel,
  simConfig: Partial<SimConfig>,
  options: EvalOptions,
): EvalReport {
  const policyTeamId = options.policyTeamId ?? 0
  const maxTicks = options.maxTicksPerEpisode ?? 3000
  const policySource = createPolicyDecisionSource(model, { deterministic: true })

  const matchups: EvalMatchup[] = options.matchups.map(({ opponentBotKind, episodes }) => {
    const merged = mergeDecisionSources(policyTeamId, policySource, BASELINE_BOTS[opponentBotKind])

    let wins = 0
    let rankSum = 0
    for (let i = 0; i < episodes; i++) {
      const seed = deriveEpisodeSeed(options.seedBase, opponentBotKind, i)
      const { rank } = playOneEpisode(simConfig, seed, policyTeamId, merged, maxTicks)
      rankSum += rank
      if (rank === 0) wins++
    }

    return {
      opponentBotKind,
      episodes,
      winRate: episodes > 0 ? wins / episodes : 0,
      avgRank: episodes > 0 ? rankSum / episodes : 0,
    }
  })

  return { iteration: options.iteration, matchups }
}
