import type { GameState, MoveCommand, UnitState } from '../sim'
import { unitWorldPos, world, worldDistBetween } from '../sim'
import { computeVisibleEnemies } from '../env'
import type { UnitDecision } from './types'
import { decideAbilityCommand } from './abilityHelpers'
import { findNearestOwnNode, findNearestSafeNode, findNearestUnclaimedNode, teammateOccupiedNodes } from './movementHelpers'

export interface GuardianBotConfig {
  /** Below this HP fraction, break off to retreat to own territory and heal. */
  healHpFraction: number
}

export function defaultGuardianBotConfig(): GuardianBotConfig {
  return { healHpFraction: 0.5 }
}

export function createGuardianBotConfig(overrides?: Partial<GuardianBotConfig>): GuardianBotConfig {
  return { ...defaultGuardianBotConfig(), ...overrides }
}

function isStationaryAt(unit: UnitState, nodeIdx: number): boolean {
  return unit.pos.from === nodeIdx && unit.pos.to === nodeIdx
}

/**
 * 自チーム所有ノードのうち、敵ユニットの攻撃範囲内に入られている(=奪還されかけている)最寄りの
 * ものを探す。BFSではなく全ノード走査+world距離で十分単純(ノード数×ユニット数程度で軽い)。
 * 味方ユニットが既にいる(=既に誰かが防衛に向かっている)ノードは候補から除外し、複数の
 * guardianが同じ1マスへ収束して片方が動けなくなるのを防ぐ(自分自身が既にそこにいる場合は
 * 除外されない — その場に留まって防衛を続けられる)。敵ユニットは除外対象に含めない —
 * 敵が実際に踏み込んでいるノードこそ最優先で反攻すべき対象であり、避ける理由にはならない。
 */
function findThreatenedOwnNode(state: GameState, unit: UnitState): number | null {
  const selfWorldPos = unitWorldPos(state, unit)
  const occupied = teammateOccupiedNodes(state, unit)
  let best: number | null = null
  let bestDist = Infinity

  for (let i = 0; i < state.nodes.length; i++) {
    const node = state.nodes[i]
    if (node.owner !== unit.teamId) continue
    if (occupied.has(i)) continue
    const nodeWorldPos = world(node)
    const threatened = state.units.some(
      (u) =>
        u.alive &&
        u.teamId !== unit.teamId &&
        worldDistBetween(unitWorldPos(state, u), nodeWorldPos) <= state.config.attackRange,
    )
    if (!threatened) continue
    const dist = worldDistBetween(selfWorldPos, nodeWorldPos)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }

  return best
}

/**
 * ユーザー要望: 陣営の目的(マップ占領率)に合わせた3性格の1つ、防衛型。奪った領地を守ることを
 * 最優先し、拡張は二の次。優先順位:
 *   1. リング退避: 現在地が安全圏外なら、HPや戦闘状況に関わらずリング中心へ最優先で戻る。
 *   2. 回復: HPが`healHpFraction`未満なら自チーム所有ノードへ戻り、着いたら静止して回復に専念する
 *      (自陣が無ければ3.の拡張と同じ手段で最寄りの未所有ノードへ向かう)。
 *   3. 防衛: 自チーム所有ノードのうち敵に狙われている(攻撃範囲内に入られた)最寄りのものがあれば
 *      そこへ急行し、居座って奪還を阻止する。
 *   4. 拡張: 上記に該当しなければ自チーム未所有の最寄りノードへ(`expanderBot`と同じ手段)。
 * 攻撃は独立ヘッドとして常に「射程内の最寄り敵」に反撃する(追撃はしない)。
 */
export function decideCommands(
  state: GameState,
  unitIds: number[],
  config: GuardianBotConfig = defaultGuardianBotConfig(),
): Map<number, UnitDecision> {
  const decisions = new Map<number, UnitDecision>()

  for (const unitId of unitIds) {
    const unit = state.units.find((u) => u.id === unitId)
    if (!unit || !unit.alive) continue

    const visibleEnemies = computeVisibleEnemies(state, unit)
    const inRangeEnemies = visibleEnemies.filter((e) => e.dist <= state.config.attackRange)
    const attackTarget = inRangeEnemies[0]?.unit.id ?? null

    const outsideRing = worldDistBetween(unitWorldPos(state, unit), state.ring.centerWorld) > state.ring.activeRadius
    const hpFraction = unit.hp / state.config.unitHP

    let command: MoveCommand

    if (outsideRing) {
      command = { type: 'moveTo', node: findNearestSafeNode(state, unit) ?? state.ring.nextCenter }
    } else if (hpFraction < config.healHpFraction) {
      const ownNode = findNearestOwnNode(state, unit)
      if (ownNode === null) {
        const target = findNearestUnclaimedNode(state, unit)
        command = target !== null ? { type: 'moveTo', node: target } : { type: 'idle' }
      } else if (isStationaryAt(unit, ownNode)) {
        command = { type: 'idle' }
      } else {
        command = { type: 'moveTo', node: ownNode }
      }
    } else {
      const threatened = findThreatenedOwnNode(state, unit)
      if (threatened !== null) {
        command = { type: 'moveTo', node: threatened }
      } else {
        const target = findNearestUnclaimedNode(state, unit)
        command = target !== null ? { type: 'moveTo', node: target } : { type: 'idle' }
      }
    }

    decisions.set(unitId, { command, attackTarget, abilityCommand: decideAbilityCommand(state, unit, visibleEnemies) })
  }

  return decisions
}
