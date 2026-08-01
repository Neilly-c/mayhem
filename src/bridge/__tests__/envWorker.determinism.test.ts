import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as path from 'node:path'
import { Env } from '../../env'
import type { ActionInput } from '../../env'
import { NdjsonDecoder } from '../protocol'
import type { BridgeResponse, ResetResult, StepResultPayload } from '../protocol'

const TSX_CLI = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
const WORKER_ENTRY = path.resolve(process.cwd(), 'src/bridge/envWorker.ts')

const SIM_CONFIG = {
  mapRadius: 4,
  wallThreshold: 0,
  teamCount: 2,
  unitsPerTeam: 1,
  maxVisibleEnemies: 2,
  decisionInterval: 2,
}

/** Minimal request/response client for a real worker subprocess, used only by this test. */
class WorkerClient {
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly decoder = new NdjsonDecoder()
  private readonly pending = new Map<number, (res: BridgeResponse) => void>()
  private nextId = 1

  constructor() {
    this.proc = spawn(process.execPath, [TSX_CLI, WORKER_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => {
      for (const raw of this.decoder.push(chunk)) {
        const msg = raw as BridgeResponse
        const resolve = this.pending.get(msg.id)
        if (resolve) {
          this.pending.delete(msg.id)
          resolve(msg)
        }
      }
    })
  }

  send(type: string, payload: unknown): Promise<BridgeResponse> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.proc.stdin.write(JSON.stringify({ id, type, payload }) + '\n')
    })
  }

  kill(): void {
    this.proc.kill()
  }
}

interface StepTrace {
  rewards: Record<number, number>
  terminations: Record<number, boolean>
  observations: Record<number, number[]>
}

describe('envWorker determinism', () => {
  it('produces results identical to driving Env directly in-process, given the same seed/config/action sequence', async () => {
    const seed = 7
    const fixedActions: ActionInput[] = [
      { move: 1, attack: 0, ability: 0 },
      { move: 2, attack: 0, ability: 0 },
      { move: 0, attack: 0, ability: 0 },
      { move: 4, attack: 0, ability: 0 },
    ]

    // Reference: drive Env directly, in-process, no bridge involved.
    const referenceEnv = Env.create(seed, { simConfig: SIM_CONFIG })
    const referenceTrace: StepTrace[] = []
    for (const action of fixedActions) {
      const actions: Record<number, ActionInput> = {}
      for (const unitId of referenceEnv.agents) actions[unitId] = action
      const result = referenceEnv.step(actions)
      const observations: Record<number, number[]> = {}
      for (const [unitId, obs] of Object.entries(result.observations)) observations[Number(unitId)] = obs.vector
      referenceTrace.push({ rewards: result.rewards, terminations: result.terminations, observations })
    }

    // Bridge: drive the exact same seed/config/action sequence through a real worker subprocess.
    const client = new WorkerClient()
    try {
      const initRes = await client.send('init', { workerId: 0, numEnvs: 1, baseSeed: 1, simConfigOverrides: SIM_CONFIG })
      expect(initRes.ok).toBe(true)

      const resetRes = await client.send('reset', { envs: [{ localEnvIndex: 0, seed }] })
      expect(resetRes.ok).toBe(true)
      if (!resetRes.ok) return
      let agents = (resetRes.result as ResetResult).envs[0].agents

      const bridgeTrace: StepTrace[] = []
      for (const action of fixedActions) {
        const stepRes = await client.send('step', {
          envs: [
            {
              localEnvIndex: 0,
              actions: agents.map((a) => ({
                unitId: a.unitId,
                move: action.move,
                attack: action.attack,
                ability: action.ability,
              })),
            },
          ],
        })
        expect(stepRes.ok).toBe(true)
        if (!stepRes.ok) return

        const envResult = (stepRes.result as StepResultPayload).envs[0]
        const rewards: Record<number, number> = {}
        const terminations: Record<number, boolean> = {}
        for (const u of envResult.units) {
          rewards[u.unitId] = u.reward
          terminations[u.unitId] = u.terminated
        }
        const nextAgents = envResult.reset ? envResult.reset.agents : envResult.continuing
        const observations: Record<number, number[]> = {}
        for (const a of nextAgents) observations[a.unitId] = a.observation
        bridgeTrace.push({ rewards, terminations, observations })
        agents = nextAgents
      }

      expect(bridgeTrace).toEqual(referenceTrace)
    } finally {
      await client.send('shutdown', {})
      client.kill()
    }
  })
})
