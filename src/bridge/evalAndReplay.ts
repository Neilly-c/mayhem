/**
 * Python側(`training-py/train_ppo.py`)がPPO更新後の定期フックとして呼ぶ、評価・リプレイ記録用
 * CLI。`loadCheckpoint`/`evaluateAgainstBots`/`recordReplay`/`saveReplay`をそのまま使うので、
 * このロジックをPython側に複製する必要がない。
 *
 *   tsx src/bridge/evalAndReplay.ts eval --checkpointDir <dir> --iteration <n> --seedBase <n>
 *       [--episodes <n>] [--opponents scripted,decisionTree,survival]
 *     -> `EvalReport`を1行のJSONで標準出力へ。
 *
 *   tsx src/bridge/evalAndReplay.ts replay --checkpointDir <dir> --iteration <n> --seed <n>
 *       [--opponent scripted|decisionTree|survival|selfPlay] [--replayDir public/replays]
 *     -> `ReplayManifestEntry`を1行のJSONで標準出力へ(ブラウザの学習リプレイ一覧に
 *     そのまま乗る — Python訓練かTS訓練かをブラウザ側は区別しない)。`--opponent selfPlay`は
 *     baseline botとの対戦ではなく、全チームがそのチェックポイントのポリシーに従う自己対戦
 *     (`recordSelfPlayReplay`)を記録する。
 *
 *   tsx src/bridge/evalAndReplay.ts pruneReplays --replayDir <dir> --keepIterations <csv>
 *     -> `{ deleted: string[] }`を1行のJSONで標準出力へ。チェックポイントの間引き
 *     (`checkpoint_pruning.py`)で生き残った反復回数の集合を`--keepIterations`に渡すことで、
 *     それに含まれない世代のリプレイをmanifest.json・ファイルの両方から取り除く
 *     (`replayWriter.ts`の`pruneReplays`をそのまま使うのでロジックはここに複製しない)。
 */
import type { BotKind } from '../agents'
import { loadCheckpoint } from '../train/checkpoint'
import { evaluateAgainstBots } from '../train/evaluate'
import { recordReplay, recordSelfPlayReplay } from '../train/replayRecording'
import { pruneReplays, saveReplay } from '../train/replayWriter'

function readArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx === -1 ? undefined : args[idx + 1]
}

async function runEval(args: string[]): Promise<void> {
  const checkpointDir = readArg(args, 'checkpointDir')
  const iterationStr = readArg(args, 'iteration')
  const seedBaseStr = readArg(args, 'seedBase')
  if (!checkpointDir || !iterationStr || !seedBaseStr) {
    throw new Error(
      'usage: evalAndReplay.ts eval --checkpointDir <dir> --iteration <n> --seedBase <n> [--episodes <n>] [--opponents csv]',
    )
  }
  const episodes = Number(readArg(args, 'episodes') ?? '5')
  const opponents = (readArg(args, 'opponents') ?? 'scripted,decisionTree,survival').split(',') as BotKind[]

  const { model, meta } = await loadCheckpoint(checkpointDir)
  const report = evaluateAgainstBots(model, meta.simConfig, {
    iteration: Number(iterationStr),
    seedBase: Number(seedBaseStr),
    matchups: opponents.map((opponentBotKind) => ({ opponentBotKind, episodes })),
  })
  console.log(JSON.stringify(report))
}

async function runReplay(args: string[]): Promise<void> {
  const checkpointDir = readArg(args, 'checkpointDir')
  const iterationStr = readArg(args, 'iteration')
  const seedStr = readArg(args, 'seed')
  if (!checkpointDir || !iterationStr || !seedStr) {
    throw new Error(
      'usage: evalAndReplay.ts replay --checkpointDir <dir> --iteration <n> --seed <n> [--opponent scripted] [--replayDir dir]',
    )
  }
  const opponent = readArg(args, 'opponent') ?? 'scripted'
  const replayDir = readArg(args, 'replayDir') ?? 'public/replays'

  const { model, meta } = await loadCheckpoint(checkpointDir)
  const replay =
    opponent === 'selfPlay'
      ? recordSelfPlayReplay(model, meta.simConfig, { iteration: Number(iterationStr), seed: Number(seedStr) })
      : recordReplay(model, meta.simConfig, {
          iteration: Number(iterationStr),
          opponentBotKind: opponent as BotKind,
          seed: Number(seedStr),
        })
  const entry = saveReplay(replay, replayDir)
  console.log(JSON.stringify(entry))
}

async function runPruneReplays(args: string[]): Promise<void> {
  const replayDir = readArg(args, 'replayDir')
  const keepIterationsStr = readArg(args, 'keepIterations')
  if (!replayDir || keepIterationsStr === undefined) {
    throw new Error('usage: evalAndReplay.ts pruneReplays --replayDir <dir> --keepIterations <csv>')
  }
  const keepIterations = new Set(
    keepIterationsStr
      .split(',')
      .filter((s) => s.length > 0)
      .map(Number),
  )
  const deleted = pruneReplays(replayDir, keepIterations)
  console.log(JSON.stringify({ deleted }))
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === 'eval') return runEval(rest)
  if (mode === 'replay') return runReplay(rest)
  if (mode === 'pruneReplays') return runPruneReplays(rest)
  throw new Error('usage: evalAndReplay.ts <eval|replay|pruneReplays> ...')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
