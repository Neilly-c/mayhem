import type { SimConfig } from '../sim'
import type { BotKind } from '../agents'

/** §11.6 のPPO自己対戦学習パイプライン全体で共有する型。 */

export interface NetworkConfig {
  obsDim: number
  /** N。攻撃ヘッドのサイズは`maxVisibleEnemies + 1`(「攻撃しない」を含む)。 */
  maxVisibleEnemies: number
  /** 既定 [256, 256]。 */
  hiddenSizes?: number[]
}

export interface PPOConfig {
  clipRatio: number
  epochs: number
  minibatchSize: number
  valueLossCoef: number
  entropyCoef: number
  maxGradNorm?: number
  /** PPO2式のクリップ付き価値損失を使うか。既定true。 */
  clipValueLoss?: boolean
  learningRate: number
}

/** rolloutBuffer.tsが1ステップ分の遷移として蓄積する、GAE適用済みのフラットなレコード。 */
export interface RolloutStep {
  obs: number[]
  moveMask: boolean[]
  attackMask: boolean[]
  moveAction: number
  attackAction: number
  /** 収集時点のポリシーによる、move+attack合成(和)のlog確率。PPO比の分母に使う。 */
  oldLogProb: number
  /** 収集時点の価値関数推定 V(obs)。 */
  value: number
  advantage: number
  return: number
}

export interface RolloutBatch {
  steps: RolloutStep[]
  /** 完了した各ライフ(ユニットの生存区間)の合計報酬。ロギング用で学習には使わない。 */
  episodeReturns: number[]
}

export interface CheckpointMeta {
  iteration: number
  networkConfig: NetworkConfig
  simConfig: SimConfig
  createdAt: string
  /** 全対戦相手の平均勝率(`checkpointPruning.ts`の`meanWinRate`)。上位N保持による自動間引きの
   * 順位付けに使う。評価が未実施のチェックポイントは`null`。 */
  score: number | null
}

export interface EvalMatchup {
  opponentBotKind: BotKind
  episodes: number
  winRate: number
  avgRank: number
}

export interface EvalReport {
  iteration: number
  matchups: EvalMatchup[]
}

export interface TrainConfig {
  numEnvs: number
  rolloutLength: number
  iterations: number
  seed: number
  gamma: number
  lambda: number
  ppo: PPOConfig
  hiddenSizes: number[]
  /** チーム数・ユニット数は観測/行動空間の次元を決めるため、学習中は不変(§4のカリキュラムの制約)。
   * 既定 teamCount:6, unitsPerTeam:3(ユーザー要望による本パイプライン固有の既定値)。 */
  simConfigOverrides: Partial<SimConfig>
  evalEveryIterations: number
  evalEpisodesPerMatchup: number
  checkpointEveryIterations: number
  checkpointDir: string
  /** ユーザー要望: チェックポイントが際限なく増え続けないよう、最新1件+スコア上位N件だけを
   * 保持し、それ以外を毎回のチェックポイント保存直後に削除する(`checkpointPruning.ts`)。既定3。 */
  keepTopNCheckpoints: number
  logPath?: string
  resumeFrom?: string
  /** ユーザー要望: 世代を追った見た目の変化を追えるように、一定反復ごとに1対戦分のリプレイを
   * `replayDir`(既定`public/replays` — Viteが静的配信する場所)へ書き出す。 */
  replayEveryIterations: number
  replayDir: string
  /** `selfPlay`はbaseline botとの対戦ではなく、全チームがそのチェックポイントのポリシーに
   * 従う自己対戦を記録する(`replayRecording.ts`の`recordSelfPlayReplay`)。 */
  replayOpponent: BotKind | 'selfPlay'
}
