import type { ActionMask, RewardConfig } from '../env'
import type { SimConfig } from '../sim'

/**
 * Node↔Python学習ブリッジのワイヤプロトコル(NDJSON over stdio、1行1JSON)。
 * リクエストはPython→Nodeワーカー、レスポンスはNodeワーカー→Python。`id`で対応付ける。
 * v1はワーカーごとに常に1リクエストだけを同時に処理する(パイプライン化はしない) —
 * 並列性は複数ワーカー*プロセス*から得る(worker_pool.py側)。
 */

export interface AgentObservation {
  unitId: number
  observation: number[]
  visibleEnemyIds: number[]
  actionMask: ActionMask
}

export interface InitPayload {
  workerId: number
  numEnvs: number
  /** ロールアウト内で発生する自動リセット(死亡でなく「勝利/決着」によるエピソード終了)のseed導出に
   * 使う。明示的な`reset`メッセージのseedはPythonが都度指定するのでこれとは別系統。 */
  baseSeed: number
  simConfigOverrides?: Partial<SimConfig>
  rewardConfigOverrides?: Partial<RewardConfig>
  maxTicks?: number
}
export interface InitResult {
  obsDim: number
  maxVisibleEnemies: number
  moveActions: 7
  /** ユーザー要望: アビリティ発動ヘッドのサイズ(`src/train/network.ts`のABILITY_ACTIONS)。 */
  abilityActions: 7
}

export interface ResetPayload {
  envs: { localEnvIndex: number; seed: number }[]
}
export interface ResetResultEnv {
  localEnvIndex: number
  episodeId: number
  agents: AgentObservation[]
}
export interface ResetResult {
  envs: ResetResultEnv[]
}

export interface StepActionEntry {
  unitId: number
  move: number
  attack: number
  ability: number
}
export interface StepPayloadEnv {
  localEnvIndex: number
  actions: StepActionEntry[]
}
export interface StepPayload {
  envs: StepPayloadEnv[]
}

export interface StepUnitResult {
  unitId: number
  reward: number
  terminated: boolean
  truncated: boolean
}
export interface BootstrapEntry {
  unitId: number
  observation: number[]
}
export interface StepResultEnv {
  localEnvIndex: number
  /** `units`(このステップの報酬/termination)が属する、リセット*前*のエピソードID。 */
  episodeId: number
  units: StepUnitResult[]
  /** リセットしなかった場合の、次ステップ用の観測。 */
  continuing: AgentObservation[]
  /** このステップでエピソードが終了した(死亡以外も含む: 勝利決着・打ち切り)場合のみ非null。
   * `bootstrap`は「まだ生きていたがエピソードが終わった」ユニットの最終観測 — Pythonがこれで
   * 価値関数のみのフォワードパスを行いGAEのbootstrap値として使う(Node側は一切フォワードパスを
   * 行わない、§0の制約)。`agents`は新しいエピソードの初期観測。 */
  reset: null | {
    newEpisodeId: number
    bootstrap: BootstrapEntry[]
    agents: AgentObservation[]
  }
}
export interface StepResultPayload {
  envs: StepResultEnv[]
}

export interface ResolveSimConfigPayload {
  iteration: number
}
export interface ResolveSimConfigResult {
  simConfig: Partial<SimConfig>
}

export type ShutdownPayload = Record<string, never>
export type ShutdownResult = Record<string, never>

interface BridgeMessageMap {
  init: { payload: InitPayload; result: InitResult }
  reset: { payload: ResetPayload; result: ResetResult }
  step: { payload: StepPayload; result: StepResultPayload }
  resolveSimConfig: { payload: ResolveSimConfigPayload; result: ResolveSimConfigResult }
  shutdown: { payload: ShutdownPayload; result: ShutdownResult }
}

export type BridgeMessageType = keyof BridgeMessageMap

export type BridgeRequest = {
  [K in BridgeMessageType]: { id: number; type: K; payload: BridgeMessageMap[K]['payload'] }
}[BridgeMessageType]

export type BridgeResponse =
  | {
      [K in BridgeMessageType]: { id: number; ok: true; result: BridgeMessageMap[K]['result'] }
    }[BridgeMessageType]
  | { id: number; ok: false; error: { message: string; stack?: string } }

export function encodeMessage(message: BridgeRequest | BridgeResponse): string {
  return JSON.stringify(message) + '\n'
}

/**
 * stdinのチャンクは行の途中で切れることがあるため、`\n`区切りで蓄積・分割する最小限の
 * ラインバッファ。`push`はその時点で完成している行だけをパース済みで返し、未完成の末尾は
 * 次回の`push`に持ち越す。
 */
export class NdjsonDecoder {
  private buffer = ''

  push(chunk: string): unknown[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown)
  }
}
