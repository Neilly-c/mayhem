/**
 * Python (`checkpoint.py`の`export_tfjs`)がTF.jsのチェックポイント形式を正しく生成できているか
 * 検証するための小さなCLI。`training-py/tests/test_tfjs_export.py`から呼ばれる、2つのサブコマンド:
 *
 *   tsx src/bridge/verifyExport.ts template --dir <dir> --obsDim <n> --maxVisibleEnemies <n> [--hiddenSizes <csv>]
 *     ランダム初期化の「テンプレート」チェックポイントを書き出す。Pythonの`export_tfjs`は
 *     このテンプレートの`model.json`(トポロジー・weightsManifest)をそのまま読み、重みバイト列
 *     だけを差し替える — TF.jsのグラフJSONをPython側で手書きしなくて済むようにするため。
 *
 *   tsx src/bridge/verifyExport.ts verify --dir <dir> --inputs <inputsJsonPath>
 *     チェックポイントを実際のTS側ロードパス(`ActorCriticModel.load`)で読み込み、固定入力
 *     ベクトルでの`.forward`出力を1行のJSONで標準出力へ書く。Python側がこの出力をnumpyでの
 *     参照フォワードパスと突き合わせて数値一致を検証する。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as tf from '@tensorflow/tfjs'
import { ActorCriticModel } from '../train/network'
import type { NetworkConfig } from '../train/types'

function readArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx === -1 ? undefined : args[idx + 1]
}

async function runTemplate(args: string[]): Promise<void> {
  const dir = readArg(args, 'dir')
  const obsDimStr = readArg(args, 'obsDim')
  const maxVisibleEnemiesStr = readArg(args, 'maxVisibleEnemies')
  const hiddenSizesStr = readArg(args, 'hiddenSizes')
  if (!dir || !obsDimStr || !maxVisibleEnemiesStr) {
    throw new Error('usage: verifyExport.ts template --dir <dir> --obsDim <n> --maxVisibleEnemies <n> [--hiddenSizes <csv>]')
  }

  const config: NetworkConfig = {
    obsDim: Number(obsDimStr),
    maxVisibleEnemies: Number(maxVisibleEnemiesStr),
    hiddenSizes: hiddenSizesStr ? hiddenSizesStr.split(',').map(Number) : undefined,
  }
  const model = ActorCriticModel.build(config)
  await model.save(dir)
  console.log(JSON.stringify({ dir, config }))
}

async function runVerify(args: string[]): Promise<void> {
  const dir = readArg(args, 'dir')
  const inputsPath = readArg(args, 'inputs')
  if (!dir || !inputsPath) {
    throw new Error('usage: verifyExport.ts verify --dir <dir> --inputs <inputsJsonPath>')
  }

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) as { networkConfig: NetworkConfig }
  const model = await ActorCriticModel.load(dir, meta.networkConfig)

  const inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf-8')) as number[][]
  const obs = tf.tensor2d(inputs)
  const { moveLogits, attackLogits, value } = model.forward(obs)

  const result = {
    moveLogits: await moveLogits.array(),
    attackLogits: await attackLogits.array(),
    value: await value.array(),
  }
  console.log(JSON.stringify(result))

  tf.dispose([obs, moveLogits, attackLogits, value])
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === 'template') return runTemplate(rest)
  if (mode === 'verify') return runVerify(rest)
  throw new Error(`usage: verifyExport.ts <template|verify> ...`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
