import * as tf from '@tensorflow/tfjs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { NetworkConfig } from './types'

export const MOVE_ACTIONS = 7

const DEFAULT_HIDDEN_SIZES = [256, 256]

function concatWeightData(data: tf.io.WeightData): ArrayBuffer {
  if (!Array.isArray(data)) return data
  const total = data.reduce((sum, buf) => sum + buf.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const buf of data) {
    out.set(new Uint8Array(buf), offset)
    offset += buf.byteLength
  }
  return out.buffer
}

/**
 * `@tensorflow/tfjs`(純JS、tfjs-nodeのネイティブバインディング無し)には`file://`用の
 * 保存/読込ハンドラが登録されていない(それは`@tensorflow/tfjs-node`が提供する機能)。
 * このプロジェクトはNode 24 + Visual Studio未導入の環境ではtfjs-nodeをビルドできなかった
 * ため(README/学習パイプラインのplan参照)、model.json + 単一の重みバイナリファイルを
 * 手動で読み書きする最小限のNode用IOHandlerをここに実装する。
 */
function nodeSaveHandler(dir: string): tf.io.IOHandler {
  return {
    save: async (artifacts: tf.io.ModelArtifacts): Promise<tf.io.SaveResult> => {
      fs.mkdirSync(dir, { recursive: true })
      const weightData = artifacts.weightData ? concatWeightData(artifacts.weightData) : new ArrayBuffer(0)
      fs.writeFileSync(path.join(dir, 'weights.bin'), Buffer.from(weightData))

      const modelJSON = {
        modelTopology: artifacts.modelTopology,
        format: artifacts.format,
        generatedBy: artifacts.generatedBy,
        convertedBy: artifacts.convertedBy,
        weightsManifest: [{ paths: ['weights.bin'], weights: artifacts.weightSpecs ?? [] }],
      }
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(modelJSON))

      return {
        modelArtifactsInfo: {
          dateSaved: new Date(),
          modelTopologyType: 'JSON',
          weightDataBytes: weightData.byteLength,
        },
      }
    },
  }
}

function nodeLoadHandler(dir: string): tf.io.IOHandler {
  return {
    load: async (): Promise<tf.io.ModelArtifacts> => {
      const modelJSON = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf-8'))
      const manifest = modelJSON.weightsManifest[0]
      const bin = fs.readFileSync(path.join(dir, manifest.paths[0]))
      const weightData = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
      return {
        modelTopology: modelJSON.modelTopology,
        weightSpecs: manifest.weights,
        weightData,
        format: modelJSON.format,
        generatedBy: modelJSON.generatedBy,
        convertedBy: modelJSON.convertedBy,
      }
    },
  }
}

export interface ActorCriticOutputs {
  /** [B, 7] */
  moveLogits: tf.Tensor2D
  /** [B, maxVisibleEnemies+1] */
  attackLogits: tf.Tensor2D
  /** [B, 1] */
  value: tf.Tensor2D
}

/**
 * 共有トランク(MLP)+ 3ヘッド(move/attack logits, value)の1枚岩の`tf.LayersModel`。
 * 全チーム・全ユニットが同じ重みを共有する(§11.1の重み共有self-play方針)。
 *
 * 学習ループ(ppo.ts)は`tf.variableGrads(lossFn)`をvarList省略で呼ぶ前提 — 省略時は
 * プロセス内の全trainable変数が対象になる(TF.js仕様)ため、`runPpoUpdate`実行中は
 * このモデル以外に学習対象のtrainable変数をプロセス内に作らないこと(将来leagueで
 * 複数モデルを同時に持つ場合は要注意、v1では単一モデルのみなので問題ない)。
 */
export class ActorCriticModel {
  readonly config: NetworkConfig
  private readonly model: tf.LayersModel

  private constructor(config: NetworkConfig, model: tf.LayersModel) {
    this.config = config
    this.model = model
  }

  static build(config: NetworkConfig): ActorCriticModel {
    const hiddenSizes = config.hiddenSizes ?? DEFAULT_HIDDEN_SIZES
    const input = tf.input({ shape: [config.obsDim], name: 'obs' })
    let trunk: tf.SymbolicTensor = input
    hiddenSizes.forEach((units, i) => {
      trunk = tf.layers
        .dense({ units, activation: 'relu', name: `trunk_${i}` })
        .apply(trunk) as tf.SymbolicTensor
    })

    const moveLogits = tf.layers
      .dense({ units: MOVE_ACTIONS, name: 'move_logits' })
      .apply(trunk) as tf.SymbolicTensor
    const attackLogits = tf.layers
      .dense({ units: config.maxVisibleEnemies + 1, name: 'attack_logits' })
      .apply(trunk) as tf.SymbolicTensor
    const value = tf.layers.dense({ units: 1, name: 'value' }).apply(trunk) as tf.SymbolicTensor

    const model = tf.model({ inputs: input, outputs: [moveLogits, attackLogits, value] })
    return new ActorCriticModel(config, model)
  }

  /**
   * `config`は呼び出し側が明示的に渡す(checkpoint.tsが`meta.json`サイドカーから読んで渡す想定) —
   * network.tsはcheckpoint.tsの存在を一切知らない(循環importを避けるため)。
   */
  static async load(dir: string, config: NetworkConfig): Promise<ActorCriticModel> {
    const model = (await tf.loadLayersModel(nodeLoadHandler(dir))) as tf.LayersModel
    return new ActorCriticModel(config, model)
  }

  /** obs: [B, obsDim]。呼び出し側が入出力tensorの破棄責任を持つ。 */
  forward(obs: tf.Tensor2D): ActorCriticOutputs {
    const [moveLogits, attackLogits, value] = this.model.apply(obs) as tf.Tensor2D[]
    return { moveLogits, attackLogits, value }
  }

  async save(dir: string): Promise<void> {
    await this.model.save(nodeSaveHandler(dir))
  }
}
