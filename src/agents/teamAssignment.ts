import type { GameState } from '../sim'
import type { UnitDecision } from './scriptedBot'
import { decideCommands as decideScripted } from './scriptedBot'
import { decideCommands as decideDecisionTree } from './decisionTreeBot'
import { decideCommands as decideSurvival } from './survivalBot'

export type BotKind = 'scripted' | 'decisionTree' | 'survival'

/** ライブ実行・リプレイ実行のどちらも、この形の関数から「今tickの意思決定」を受け取る。 */
export type DecisionSource = (state: GameState, aliveUnitIds: number[]) => Map<number, UnitDecision>

const BOT_IMPLEMENTATIONS: Record<BotKind, DecisionSource> = {
  scripted: decideScripted,
  decisionTree: decideDecisionTree,
  survival: decideSurvival,
}

/**
 * チームごとに異なるbotを割り当てて実行し、結果を1つのMapへ合成するだけの薄いディスパッチャ。
 * `assignment`に無いチームは`defaultBot`を使う。
 */
export function createTeamRoutedDecisionSource(
  assignment: Map<number, BotKind>,
  defaultBot: BotKind = 'scripted',
): DecisionSource {
  return (state, unitIds) => {
    const idsByBot = new Map<BotKind, number[]>()
    for (const unitId of unitIds) {
      const unit = state.units.find((u) => u.id === unitId)
      if (!unit) continue
      const bot = assignment.get(unit.teamId) ?? defaultBot
      const ids = idsByBot.get(bot)
      if (ids) ids.push(unitId)
      else idsByBot.set(bot, [unitId])
    }

    const merged = new Map<number, UnitDecision>()
    for (const [bot, ids] of idsByBot) {
      const decisions = BOT_IMPLEMENTATIONS[bot](state, ids)
      for (const [unitId, decision] of decisions) merged.set(unitId, decision)
    }
    return merged
  }
}
