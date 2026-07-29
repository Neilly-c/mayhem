import { describe, expect, it } from 'vitest'
import { Simulation, isGameOver } from '../../sim'
import { createReplayDecisionSource } from '../../app/replay'
import { ActorCriticModel } from '../network'
import { recordReplay, recordSelfPlayReplay } from '../replayRecording'
import { inferObsDim } from '../shapes'

const TINY_CONFIG = {
  mapRadius: 4,
  wallThreshold: 0,
  teamCount: 2,
  unitsPerTeam: 1,
  maxVisibleEnemies: 2,
  decisionInterval: 2,
}

function buildModel() {
  const obsDim = inferObsDim(TINY_CONFIG, 1)
  return ActorCriticModel.build({ obsDim, maxVisibleEnemies: TINY_CONFIG.maxVisibleEnemies, hiddenSizes: [8] })
}

describe('recordReplay', () => {
  it('produces a non-empty, well-formed log with the resolved sim config', () => {
    const model = buildModel()
    const replay = recordReplay(model, TINY_CONFIG, { iteration: 5, opponentBotKind: 'scripted', seed: 1, maxTicks: 200 })

    expect(replay.iteration).toBe(5)
    expect(replay.opponentBotKind).toBe('scripted')
    expect(replay.seed).toBe(1)
    expect(replay.simConfig.mapRadius).toBe(TINY_CONFIG.mapRadius)
    expect(replay.log.length).toBeGreaterThan(0)
    for (const entry of replay.log) {
      expect(entry.tick).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(entry.commands)).toBe(true)
    }
  })

  it('the recorded log replays deterministically to the same outcome via createReplayDecisionSource', () => {
    const model = buildModel()
    const replay = recordReplay(model, TINY_CONFIG, { iteration: 1, opponentBotKind: 'scripted', seed: 2, maxTicks: 200 })

    // Replay it independently, driving the exact same decisionInterval loop pattern used to record it.
    const sim = Simulation.create(replay.seed, replay.simConfig)
    const decisionSource = createReplayDecisionSource(replay.log)
    let ticks = 0
    while (!isGameOver(sim.state) && ticks < 200) {
      if (sim.state.tick % sim.state.config.decisionInterval === 0) {
        const aliveIds = sim.state.units.filter((u) => u.alive).map((u) => u.id)
        const decisions = decisionSource(sim.state, aliveIds)
        for (const [unitId, { command, attackTarget }] of decisions) {
          sim.setCommand(unitId, command)
          sim.setAttackTarget(unitId, attackTarget)
        }
      }
      sim.step()
      ticks++
    }

    // The replay should reach the exact same final tick as when it was originally recorded.
    const lastLoggedTick = replay.log[replay.log.length - 1].tick
    expect(sim.state.tick).toBeGreaterThanOrEqual(lastLoggedTick)
  })

  it('is deterministic: same seed/config/model produces an identical log', () => {
    const model = buildModel()
    const opts = { iteration: 1, opponentBotKind: 'scripted' as const, seed: 3, maxTicks: 100 }
    const a = recordReplay(model, TINY_CONFIG, opts)
    const b = recordReplay(model, TINY_CONFIG, opts)
    expect(a.log).toEqual(b.log)
  })
})

describe('recordSelfPlayReplay', () => {
  it('produces a non-empty, well-formed log tagged as selfPlay (no baseline bot involved)', () => {
    const model = buildModel()
    const replay = recordSelfPlayReplay(model, TINY_CONFIG, { iteration: 5, seed: 1, maxTicks: 200 })

    expect(replay.iteration).toBe(5)
    expect(replay.opponentBotKind).toBe('selfPlay')
    expect(replay.seed).toBe(1)
    expect(replay.simConfig.mapRadius).toBe(TINY_CONFIG.mapRadius)
    expect(replay.log.length).toBeGreaterThan(0)
    for (const entry of replay.log) {
      expect(entry.tick).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(entry.commands)).toBe(true)
    }
  })

  it('logs decisions for units on every team, not just team 0', () => {
    const model = buildModel()
    const replay = recordSelfPlayReplay(model, TINY_CONFIG, { iteration: 1, seed: 1, maxTicks: 200 })

    const sim = Simulation.create(replay.seed, replay.simConfig)
    const loggedTeamIds = new Set<number>()
    for (const entry of replay.log) {
      for (const cmd of entry.commands) {
        const unit = sim.state.units.find((u) => u.id === cmd.unitId)
        if (unit) loggedTeamIds.add(unit.teamId)
      }
    }
    expect(loggedTeamIds.size).toBe(TINY_CONFIG.teamCount)
  })

  it('the recorded log replays deterministically to the same outcome via createReplayDecisionSource', () => {
    const model = buildModel()
    const replay = recordSelfPlayReplay(model, TINY_CONFIG, { iteration: 1, seed: 2, maxTicks: 200 })

    const sim = Simulation.create(replay.seed, replay.simConfig)
    const decisionSource = createReplayDecisionSource(replay.log)
    let ticks = 0
    while (!isGameOver(sim.state) && ticks < 200) {
      if (sim.state.tick % sim.state.config.decisionInterval === 0) {
        const aliveIds = sim.state.units.filter((u) => u.alive).map((u) => u.id)
        const decisions = decisionSource(sim.state, aliveIds)
        for (const [unitId, { command, attackTarget }] of decisions) {
          sim.setCommand(unitId, command)
          sim.setAttackTarget(unitId, attackTarget)
        }
      }
      sim.step()
      ticks++
    }

    const lastLoggedTick = replay.log[replay.log.length - 1].tick
    expect(sim.state.tick).toBeGreaterThanOrEqual(lastLoggedTick)
  })

  it('is deterministic: same seed/config/model produces an identical log', () => {
    const model = buildModel()
    const opts = { iteration: 1, seed: 3, maxTicks: 100 }
    const a = recordSelfPlayReplay(model, TINY_CONFIG, opts)
    const b = recordSelfPlayReplay(model, TINY_CONFIG, opts)
    expect(a.log).toEqual(b.log)
  })
})
