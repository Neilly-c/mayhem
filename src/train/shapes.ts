import type { SimConfig } from '../sim'
import { Env } from '../env'

/**
 * `Observation.vector`の長さは`unitsPerTeam`/`maxVisibleEnemies`/`patchHops`/`teamCount`の関数
 * (env/observation.ts参照)。この式をここで手で複製すると`observation.ts`の変更に追随できず
 * ドリフトするリスクがあるため、実際に1体分の`Env`を立ち上げて読み取ることで導出する。
 */
export function inferObsDim(simConfig: Partial<SimConfig>, seed = 0): number {
  const env = Env.create(seed, { simConfig })
  const observations = env.reset(seed)
  const firstAgentId = env.agents[0]
  const obs = firstAgentId === undefined ? undefined : observations[firstAgentId]
  if (obs === undefined) {
    throw new Error('inferObsDim: no agents were spawned for the given simConfig')
  }
  return obs.vector.length
}
