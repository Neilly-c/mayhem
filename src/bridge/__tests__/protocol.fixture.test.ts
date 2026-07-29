import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { NdjsonDecoder } from '../protocol'

/**
 * Cross-language fixture (see training-py/tests/test_protocol_codec.py's
 * `test_cross_language_fixture_decodes_as_expected` for the Python side). The cheapest available
 * guard against the two hand-written NDJSON codecs drifting apart: both sides parse the SAME
 * checked-in fixture file and assert the same hardcoded expectations. If the fixture's shape ever
 * changes, both this test and its Python counterpart need matching updates.
 */
const FIXTURE_PATH = path.resolve(process.cwd(), 'training-py/tests/fixtures/sample_messages.ndjson')

describe('cross-language protocol fixture', () => {
  it('decodes as expected (mirrors the Python-side assertions)', () => {
    const decoder = new NdjsonDecoder()
    const text = fs.readFileSync(FIXTURE_PATH, 'utf-8')
    const messages = decoder.push(text) as Record<string, unknown>[]

    expect(messages).toHaveLength(11)
    const [initReq, initRes, , resetRes, , stepRes, , resolveRes, shutdownReq, shutdownRes, errorRes] = messages

    expect(initReq).toEqual({
      id: 1,
      type: 'init',
      payload: {
        workerId: 0,
        numEnvs: 4,
        baseSeed: 42,
        simConfigOverrides: { mapRadius: 8, teamCount: 6, unitsPerTeam: 3 },
        maxTicks: 3000,
      },
    })
    const initResult = initRes.result as { obsDim: number; maxVisibleEnemies: number }
    expect(initResult.obsDim).toBe(370)
    expect(initResult.maxVisibleEnemies).toBe(6)

    const resetEnv = (resetRes.result as { envs: { agents: { unitId: number; actionMask: { move: boolean[] } }[] }[] })
      .envs[0]
    expect(resetEnv.agents[0].unitId).toBe(0)
    expect(resetEnv.agents[0].actionMask.move).toEqual([true, true, true, true, true, true, true])

    const stepEnv = (
      stepRes.result as {
        envs: {
          units: { reward: number }[]
          reset: { newEpisodeId: number; bootstrap: { unitId: number }[]; agents: { unitId: number }[] } | null
        }[]
      }
    ).envs[0]
    expect(stepEnv.units[0].reward).toBe(0.5)
    expect(stepEnv.reset?.newEpisodeId).toBe(1)
    expect(stepEnv.reset?.bootstrap[0].unitId).toBe(0)
    expect(stepEnv.reset?.agents[0].unitId).toBe(5)

    expect((resolveRes.result as { simConfig: unknown }).simConfig).toEqual({
      mapRadius: 14,
      teamCount: 6,
      unitsPerTeam: 3,
    })

    expect(shutdownReq).toEqual({ id: 5, type: 'shutdown', payload: {} })
    expect(shutdownRes).toEqual({ id: 5, ok: true, result: {} })

    expect(errorRes).toEqual({ id: 6, ok: false, error: { message: 'step: env 3 was never reset' } })
  })
})
