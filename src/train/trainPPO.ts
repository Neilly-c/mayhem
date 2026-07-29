/**
 * PPO自己対戦学習パイプラインのCLIエントリポイント。`npm run train -- [flags]`で起動する。
 *
 * 主なフラグ(全て省略可、既定値あり):
 *   --numEnvs --rolloutLength --iterations --seed
 *   --gamma --lambda --clipRatio --epochs --minibatchSize --valueLossCoef --entropyCoef --learningRate
 *   --evalEvery --evalEpisodes --checkpointEvery --checkpointDir --keepTopNCheckpoints --resumeFrom --logPath
 *   --replayEvery --replayDir --replayOpponent expander|guardian|raider|selfPlay
 *     (ユーザー要望: 世代ごとのリプレイをブラウザで再生できるよう、既定で`public/replays`へ
 *     書き出す — `npm run dev`実行中ならそのまま`/replays/manifest.json`としてfetchできる。
 *     `selfPlay`はbaseline botとの対戦ではなく、全チームがそのチェックポイントのポリシーに
 *     従う自己対戦を記録する(実際の学習ロールアウトと同じ構成)。チェックポイントの間引き
 *     (--keepTopNCheckpoints)で消えた世代のリプレイも同時に間引かれるので、UIには常に現存する
 *     チェックポイント世代のリプレイだけが並ぶ)
 *
 * §11.1の重み共有self-play方針により、全チーム・全ユニットが単一の共有ポリシーで動く
 * (`teamCount:6, unitsPerTeam:3`固定、`curriculum.ts`参照)。leagueは v1 のスコープ外
 * (`rolloutBuffer.ts`は将来league対応できるよう構造化してあるが、実装はしていない)。
 */
import * as path from 'node:path'
import * as tf from '@tensorflow/tfjs'
import type { SimConfig } from '../sim'
import { createConfig, deriveRng, randInt } from '../sim'
import { Env } from '../env'
import { ActorCriticModel } from './network'
import { collectRollout, createRolloutState } from './rolloutBuffer'
import { runPpoUpdate } from './ppo'
import { evaluateAgainstBots } from './evaluate'
import { loadCheckpoint, saveCheckpoint } from './checkpoint'
import { listCheckpoints, meanWinRate, pruneCheckpoints } from './checkpointPruning'
import { createLogger } from './logger'
import { curriculumSimConfig } from './curriculum'
import { inferObsDim } from './shapes'
import { recordReplay, recordSelfPlayReplay } from './replayRecording'
import { pruneReplays, saveReplay } from './replayWriter'
import type { EvalReport, NetworkConfig, PPOConfig, TrainConfig } from './types'

const CHECKPOINT_DIR_PATTERN = /^iter-\d+$/
/** リプレイの間引き用: TS(`iter-N`)・Python(`py-iter-N`)どちらの現存チェックポイントも対象に
 * 含める(`public/replays`は両パイプライン共有なので、自分側のパターンだけで判定すると
 * もう一方のパイプラインの現存チェックポイントのリプレイを誤って削除してしまう)。 */
const ANY_CHECKPOINT_DIR_PATTERN = /^(py-)?iter-\d+$/

function defaultPPOConfig(): PPOConfig {
  return {
    clipRatio: 0.2,
    epochs: 4,
    minibatchSize: 256,
    valueLossCoef: 0.5,
    entropyCoef: 0.01,
    learningRate: 3e-4,
    clipValueLoss: true,
  }
}

function defaultTrainConfig(): TrainConfig {
  return {
    numEnvs: 8,
    rolloutLength: 128,
    iterations: 1000,
    seed: 1,
    gamma: 0.99,
    lambda: 0.95,
    ppo: defaultPPOConfig(),
    hiddenSizes: [256, 256],
    simConfigOverrides: {},
    evalEveryIterations: 20,
    evalEpisodesPerMatchup: 5,
    checkpointEveryIterations: 20,
    checkpointDir: 'checkpoints',
    keepTopNCheckpoints: 3,
    replayEveryIterations: 20,
    replayDir: path.join('public', 'replays'),
    replayOpponent: 'expander',
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = 'true'
    }
  }
  return out
}

function applyArgsToConfig(config: TrainConfig, args: Record<string, string>): TrainConfig {
  const num = (key: string, cur: number) => (args[key] !== undefined ? Number(args[key]) : cur)
  return {
    ...config,
    numEnvs: num('numEnvs', config.numEnvs),
    rolloutLength: num('rolloutLength', config.rolloutLength),
    iterations: num('iterations', config.iterations),
    seed: num('seed', config.seed),
    gamma: num('gamma', config.gamma),
    lambda: num('lambda', config.lambda),
    evalEveryIterations: num('evalEvery', config.evalEveryIterations),
    evalEpisodesPerMatchup: num('evalEpisodes', config.evalEpisodesPerMatchup),
    checkpointEveryIterations: num('checkpointEvery', config.checkpointEveryIterations),
    checkpointDir: args.checkpointDir ?? config.checkpointDir,
    keepTopNCheckpoints: num('keepTopNCheckpoints', config.keepTopNCheckpoints),
    resumeFrom: args.resumeFrom ?? config.resumeFrom,
    logPath: args.logPath ?? config.logPath,
    replayEveryIterations: num('replayEvery', config.replayEveryIterations),
    replayDir: args.replayDir ?? config.replayDir,
    replayOpponent: (args.replayOpponent as TrainConfig['replayOpponent']) ?? config.replayOpponent,
    ppo: {
      ...config.ppo,
      clipRatio: num('clipRatio', config.ppo.clipRatio),
      epochs: num('epochs', config.ppo.epochs),
      minibatchSize: num('minibatchSize', config.ppo.minibatchSize),
      valueLossCoef: num('valueLossCoef', config.ppo.valueLossCoef),
      entropyCoef: num('entropyCoef', config.ppo.entropyCoef),
      learningRate: num('learningRate', config.ppo.learningRate),
    },
  }
}

function buildEnvs(numEnvs: number, simConfig: Partial<SimConfig>, baseSeed: number): Env[] {
  return Array.from({ length: numEnvs }, (_, i) => {
    const rng = deriveRng(baseSeed, `train:envInit:${i}`)
    return Env.create(randInt(rng, 2 ** 31), { simConfig })
  })
}

function resolvedSimConfigFor(iteration: number, trainConfig: TrainConfig): Partial<SimConfig> {
  return { ...curriculumSimConfig(iteration), ...trainConfig.simConfigOverrides }
}

function simConfigsEqual(a: Partial<SimConfig>, b: Partial<SimConfig>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const trainConfig = applyArgsToConfig(defaultTrainConfig(), args)
  const logger = createLogger(trainConfig.logPath)

  let iterationStart = 0
  let currentSimConfig = resolvedSimConfigFor(0, trainConfig)
  let model: ActorCriticModel
  let networkConfig: NetworkConfig

  if (trainConfig.resumeFrom) {
    const { model: loadedModel, meta } = await loadCheckpoint(trainConfig.resumeFrom)
    model = loadedModel
    networkConfig = meta.networkConfig
    iterationStart = meta.iteration
    currentSimConfig = resolvedSimConfigFor(iterationStart, trainConfig)
    logger.log({ event: 'resumed', iteration: iterationStart, dir: trainConfig.resumeFrom })
  } else {
    const resolved = createConfig(currentSimConfig)
    networkConfig = {
      obsDim: inferObsDim(currentSimConfig, trainConfig.seed),
      maxVisibleEnemies: resolved.maxVisibleEnemies,
      hiddenSizes: trainConfig.hiddenSizes,
    }
    model = ActorCriticModel.build(networkConfig)
    logger.log({ event: 'initialized', networkConfig, simConfig: currentSimConfig })
  }

  // Adam optimizer state (momentum/velocity) is not checkpointed in v1 — a resumed run starts
  // with a fresh optimizer even though the model weights themselves carry over.
  const optimizer = tf.train.adam(trainConfig.ppo.learningRate)

  let envs = buildEnvs(trainConfig.numEnvs, currentSimConfig, trainConfig.seed)
  let rolloutState = createRolloutState(envs, trainConfig.seed)

  for (let iteration = iterationStart; iteration < trainConfig.iterations; iteration++) {
    const desiredSimConfig = resolvedSimConfigFor(iteration, trainConfig)
    if (!simConfigsEqual(desiredSimConfig, currentSimConfig)) {
      currentSimConfig = desiredSimConfig
      envs = buildEnvs(trainConfig.numEnvs, currentSimConfig, trainConfig.seed + iteration)
      rolloutState = createRolloutState(envs, trainConfig.seed + iteration)
      logger.log({ event: 'curriculum_stage_change', iteration, simConfig: currentSimConfig })
    }

    const batch = collectRollout(rolloutState, model, {
      rolloutLength: trainConfig.rolloutLength,
      gamma: trainConfig.gamma,
      lambda: trainConfig.lambda,
      baseSeed: trainConfig.seed + iteration,
    })

    const shuffleRng = deriveRng(trainConfig.seed, `train:ppoShuffle:${iteration}`)
    const stats = runPpoUpdate(model, optimizer, batch, trainConfig.ppo, shuffleRng)

    const meanEpisodeReturn =
      batch.episodeReturns.length > 0
        ? batch.episodeReturns.reduce((a, b) => a + b, 0) / batch.episodeReturns.length
        : null

    logger.log({
      event: 'iteration',
      iteration,
      steps: batch.steps.length,
      episodes: batch.episodeReturns.length,
      meanEpisodeReturn,
      ...stats,
    })

    const shouldEval = (iteration + 1) % trainConfig.evalEveryIterations === 0
    const shouldCheckpoint = (iteration + 1) % trainConfig.checkpointEveryIterations === 0

    // 間引き(下記)にはチェックポイントごとのスコアが要るため、通常のeval周期と一致していなくても
    // チェックポイント保存時は必ずevalを実行する(既定では両周期が同じなので追加コストは無い)。
    let evalReport: EvalReport | undefined
    if (shouldEval || shouldCheckpoint) {
      evalReport = evaluateAgainstBots(model, currentSimConfig, {
        iteration: iteration + 1,
        seedBase: trainConfig.seed + iteration,
        matchups: [
          { opponentBotKind: 'expander', episodes: trainConfig.evalEpisodesPerMatchup },
          { opponentBotKind: 'guardian', episodes: trainConfig.evalEpisodesPerMatchup },
          { opponentBotKind: 'raider', episodes: trainConfig.evalEpisodesPerMatchup },
        ],
      })
      logger.log({ event: 'eval', ...evalReport })
    }

    if ((iteration + 1) % trainConfig.replayEveryIterations === 0) {
      const replay =
        trainConfig.replayOpponent === 'selfPlay'
          ? recordSelfPlayReplay(model, currentSimConfig, { iteration: iteration + 1, seed: trainConfig.seed + iteration })
          : recordReplay(model, currentSimConfig, {
              iteration: iteration + 1,
              opponentBotKind: trainConfig.replayOpponent,
              seed: trainConfig.seed + iteration,
            })
      const entry = saveReplay(replay, trainConfig.replayDir)
      logger.log({ event: 'replay', ...entry })
    }

    if (shouldCheckpoint) {
      const dir = path.join(trainConfig.checkpointDir, `iter-${iteration + 1}`)
      const score = evalReport ? meanWinRate(evalReport) : null
      await saveCheckpoint(model, dir, {
        iteration: iteration + 1,
        networkConfig,
        simConfig: createConfig(currentSimConfig),
        createdAt: new Date().toISOString(),
        score,
      })
      logger.log({ event: 'checkpoint', iteration: iteration + 1, dir, score })

      const deleted = pruneCheckpoints(trainConfig.checkpointDir, CHECKPOINT_DIR_PATTERN, trainConfig.keepTopNCheckpoints)
      if (deleted.length > 0) logger.log({ event: 'checkpoint_pruned', iteration: iteration + 1, deleted })

      // ユーザー要望: 間引きで消えたチェックポイント世代のリプレイもUIから消す。生き残った
      // チェックポイントの反復回数を再取得し、それに含まれない世代のリプレイを削除する
      // (replayEveryIterationsがcheckpointEveryIterationsと異なる周期でも、チェックポイントの
      // 無い世代のリプレイは同様に間引かれる)。ANY_CHECKPOINT_DIR_PATTERNでTS/Python両方の
      // 現存チェックポイントを見る — CHECKPOINT_DIR_PATTERN(自分側のみ)だと、もう一方の
      // パイプラインが今も持っているチェックポイントのリプレイまで誤って削除してしまう。
      const keptIterations = new Set(
        listCheckpoints(trainConfig.checkpointDir, ANY_CHECKPOINT_DIR_PATTERN).map((c) => c.iteration),
      )
      const deletedReplays = pruneReplays(trainConfig.replayDir, keptIterations)
      if (deletedReplays.length > 0) {
        logger.log({ event: 'replay_pruned', iteration: iteration + 1, deleted: deletedReplays })
      }
    }
  }

  logger.log({ event: 'done', iterations: trainConfig.iterations })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
