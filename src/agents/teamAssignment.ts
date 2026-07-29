import { decideCommands as decideExpander } from './expanderBot'
import { decideCommands as decideGuardian } from './guardianBot'
import { decideCommands as decideRaider } from './raiderBot'
import type { DecisionSource, UnitDecision } from './types'

export type BotKind = 'expander' | 'guardian' | 'raider'

/** ユーザー要望: プルダウンの既定値をチームNo. mod nにするための並び順。順序を変えると
 * 既定の割り当てが変わるので、変更時は要注意。 */
export const BOT_KINDS: readonly BotKind[] = ['expander', 'guardian', 'raider']

/** チームIDに応じて`BOT_KINDS`を`teamId % BOT_KINDS.length`で巡回する既定bot。 */
export function defaultBotKindForTeam(teamId: number): BotKind {
  return BOT_KINDS[((teamId % BOT_KINDS.length) + BOT_KINDS.length) % BOT_KINDS.length]
}

const BOT_IMPLEMENTATIONS: Record<BotKind, DecisionSource> = {
  expander: decideExpander,
  guardian: decideGuardian,
  raider: decideRaider,
}

/**
 * チームごとに異なるbotを割り当てて実行し、結果を1つのMapへ合成するだけの薄いディスパッチャ。
 * `assignment`に無いチームは`defaultBotKindForTeam`(チームNo. mod n)を使う。
 */
export function createTeamRoutedDecisionSource(assignment: Map<number, BotKind>): DecisionSource {
  return (state, unitIds) => {
    const idsByBot = new Map<BotKind, number[]>()
    for (const unitId of unitIds) {
      const unit = state.units.find((u) => u.id === unitId)
      if (!unit) continue
      const bot = assignment.get(unit.teamId) ?? defaultBotKindForTeam(unit.teamId)
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
