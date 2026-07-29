import type { DecisionSource, UnitDecision } from '../agents'
import type { MoveCommand } from '../sim'

export type { DecisionSource } from '../agents'

export interface LoggedDecision {
  tick: number
  commands: { unitId: number; command: MoveCommand; attackTarget: number | null }[]
}

export function decisionsToLogEntry(tick: number, decisions: Map<number, UnitDecision>): LoggedDecision {
  return {
    tick,
    commands: Array.from(decisions.entries()).map(([unitId, d]) => ({
      unitId,
      command: d.command,
      attackTarget: d.attackTarget,
    })),
  }
}

/**
 * 記録済みログから、その時点のtickに発生した意思決定をそのまま返す決定的な再現ソース。
 * ライブ時の決定元(現在はスクリプトbot、将来は確率的なRLポリシーもありうる)に依存しないため、
 * 同一のリプレイ機構がそのまま使い続けられる。
 */
export function createReplayDecisionSource(log: LoggedDecision[]): DecisionSource {
  const byTick = new Map<number, LoggedDecision>()
  for (const entry of log) byTick.set(entry.tick, entry)

  return (state) => {
    const decisions = new Map<number, UnitDecision>()
    const entry = byTick.get(state.tick)
    if (!entry) return decisions
    for (const { unitId, command, attackTarget } of entry.commands) {
      decisions.set(unitId, { command, attackTarget })
    }
    return decisions
  }
}
