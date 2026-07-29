import type { SimConfig } from '../sim'
import { Simulation, createConfig, isGameOver } from '../sim'
import { createRewardConfig } from './rewardConfig'
import { computeVisibleEnemies } from './visibility'
import { buildNodeIndex, buildObservation } from './observation'
import { buildActionMask, decodeAction } from './actions'
import { applyTickRewards, applyWinnerBonus } from './rewards'
import type { ActionInput, ActionMask, Observation, RewardConfig, StepInfo, StepResult } from './types'

export interface EnvOptions {
  simConfig?: Partial<SimConfig>
  rewardConfig?: Partial<RewardConfig>
  /** Optional episode-length cap. Once reached, all remaining agents are truncated. */
  maxTicks?: number
}

/**
 * §11.5 Gym/PettingZoo(Parallel)風のRL環境。エージェント=生存ユニット(§11.1推奨案)。
 * `sim`をラップするだけで共有可変状態は持たないため、複数インスタンスを並べれば
 * そのままベクトル化できる。
 */
export class Env {
  private readonly simConfig: SimConfig
  private readonly rewardConfig: RewardConfig
  private readonly maxTicks?: number
  private sim!: Simulation
  private winnerBonusAwarded = false
  /** `applyTickRewards`の次リング先回りシェイピング用、ユニットID毎の前tickポテンシャル値。
   * ユニットIDはエピソードをまたいで使い回される(`entities.ts`が毎回0から振り直す)ため、
   * `reset`のたびに必ずクリアする — でないと前エピソードの無関係なユニットの値を
   * 誤って引き継いでしまう。 */
  private ringPotentialMemo = new Map<number, number>()

  private constructor(simConfig: SimConfig, rewardConfig: RewardConfig, maxTicks: number | undefined) {
    this.simConfig = simConfig
    this.rewardConfig = rewardConfig
    this.maxTicks = maxTicks
  }

  static create(seed: number, options: EnvOptions = {}): Env {
    const simConfig = createConfig(options.simConfig)
    const rewardConfig = createRewardConfig(simConfig.teamCount, options.rewardConfig)
    const env = new Env(simConfig, rewardConfig, options.maxTicks)
    env.reset(seed)
    return env
  }

  /** 現在生存しているユニットID(=エージェント集合)。 */
  get agents(): number[] {
    return this.sim.state.units.filter((u) => u.alive).map((u) => u.id)
  }

  get state() {
    return this.sim.state
  }

  /** §11.5 `reset(seed) -> obs`。seedは必須(simと同様、暗黙の`Math.random()`は使わない)。 */
  reset(seed: number): Record<number, Observation> {
    this.sim = Simulation.create(seed, this.simConfig)
    this.winnerBonusAwarded = false
    this.ringPotentialMemo.clear()
    return this.buildAgentData().observations
  }

  /**
   * 1回の意思決定(=`decisionInterval`(既定5) tick分)を進める。actionsは最初のtickだけ適用すれば
   * よい(コマンド/攻撃対象はsim側で次の指令まで継続する)。ブロック内でゲームが終了したら早期に
   * 打ち切る。
   */
  step(actions: Record<number, ActionInput>): StepResult {
    const priorAgents = this.agents
    const priorAgentSet = new Set(priorAgents)

    for (const [unitIdStr, action] of Object.entries(actions)) {
      const unitId = Number(unitIdStr)
      if (!priorAgentSet.has(unitId)) continue
      const unit = this.sim.state.units.find((u) => u.id === unitId)
      if (!unit) continue
      const visibleEnemyIds = computeVisibleEnemies(this.sim.state, unit).map((e) => e.unit.id)
      const { command, attackTarget } = decodeAction(action, unit.pos.to, visibleEnemyIds)
      this.sim.setCommand(unitId, command)
      this.sim.setAttackTarget(unitId, attackTarget)
    }

    const rewards: Record<number, number> = {}
    const deadThisBlock = new Set<number>()

    for (let i = 0; i < this.simConfig.decisionInterval; i++) {
      const events = this.sim.step()
      applyTickRewards(rewards, events, this.sim.state, this.rewardConfig, this.ringPotentialMemo)
      for (const death of events.deaths) deadThisBlock.add(death.unitId)
      if (isGameOver(this.sim.state)) break
    }

    if (isGameOver(this.sim.state) && !this.winnerBonusAwarded) {
      applyWinnerBonus(rewards, this.sim.state, this.rewardConfig)
      this.winnerBonusAwarded = true
    }

    const { observations, infos } = this.buildAgentData()

    const truncated = this.maxTicks !== undefined && this.sim.state.tick >= this.maxTicks
    const terminations: Record<number, boolean> = {}
    const truncations: Record<number, boolean> = {}
    for (const unitId of priorAgents) {
      if (!(unitId in rewards)) rewards[unitId] = 0
      terminations[unitId] = deadThisBlock.has(unitId)
      truncations[unitId] = truncated && !deadThisBlock.has(unitId)
    }

    return { observations, rewards, terminations, truncations, infos }
  }

  private buildAgentData(): { observations: Record<number, Observation>; infos: Record<number, StepInfo> } {
    const state = this.sim.state
    const nodeIndex = buildNodeIndex(state)
    const observations: Record<number, Observation> = {}
    const infos: Record<number, StepInfo> = {}

    for (const unit of state.units) {
      if (!unit.alive) continue
      const visibleEnemies = computeVisibleEnemies(state, unit)
      const observation = buildObservation(state, unit, visibleEnemies, nodeIndex)
      observations[unit.id] = observation
      infos[unit.id] = {
        actionMask: buildActionMask(state, unit, visibleEnemies),
        visibleEnemyIds: observation.visibleEnemyIds,
      }
    }

    return { observations, infos }
  }
}

/**
 * `Env.reset(seed)`は観測(`Observation`)しか返さず、行動マスク(`ActionMask`)は返さない
 * (`Env`の内部`buildAgentData`は両方計算しているが、`reset`の戻り値契約は既存の呼び出し側
 * 全て(`env.test.ts`、`Env`を直接使う各所)を壊さないよう`Observation`のみのまま据え置いている)。
 * リセット直後の最初の意思決定ステップにはマスクが要る呼び出し側(`rolloutBuffer.ts`、
 * `src/bridge/envWorker.ts`)は、代わりにこの関数で`env.agents`/`env.state`から計算し直す —
 * `Env`自体には手を入れず、公開APIは`reset`/`step`/`agents`/`state`のまま。
 */
export function buildActionMasksForEnv(env: Env): Record<number, ActionMask> {
  const state = env.state
  const masks: Record<number, ActionMask> = {}
  for (const unitId of env.agents) {
    const unit = state.units.find((u) => u.id === unitId)
    if (!unit) continue
    masks[unitId] = buildActionMask(state, unit, computeVisibleEnemies(state, unit))
  }
  return masks
}
