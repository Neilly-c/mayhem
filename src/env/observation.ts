import type { GameState, UnitState } from '../sim'
import {
  DIRECTIONS,
  axialKey,
  nodesInRadius,
  unitElevation,
  unitWorldPos,
  world,
  worldDistBetween,
} from '../sim'
import type { Observation } from './types'
import type { VisibleEnemy } from './visibility'

/** ノードのq,rから配列インデックスを引くための索引。マップはtick中不変なので1回作れば使い回せる。 */
export function buildNodeIndex(state: GameState): Map<string, number> {
  const index = new Map<string, number>()
  state.nodes.forEach((n, i) => index.set(axialKey(n), i))
  return index
}

/**
 * §11.2 固定長エゴセントリック観測: 自身 + 味方(unitsPerTeam-1体) + 視認中敵(上限N体) +
 * 局所地形パッチ(半径patchHopsホップ) + 全体サマリ、をすべて正規化して1本のnumber[]に連結する。
 * 全マップは入力しない。部分観測(視認外の敵・未来のリング)が前提。
 */
export function buildObservation(
  state: GameState,
  self: UnitState,
  visibleEnemies: VisibleEnemy[],
  nodeIndex: Map<string, number>,
): Observation {
  const config = state.config
  const mapScale = Math.max(1, config.mapRadius)
  const selfWorldPos = unitWorldPos(state, self)
  const selfElevation = unitElevation(state, self)
  const selfNode = state.nodes[self.pos.to]
  const onNode = self.pos.from === self.pos.to

  // --- 自身 ---
  const centerWorldPos = state.ring.centerWorld
  const relToCenter = [
    (selfWorldPos.x - centerWorldPos.x) / mapScale,
    (selfWorldPos.y - centerWorldPos.y) / mapScale,
  ]
  const ringRadiusNorm = state.ring.activeRadius / mapScale
  const ticksUntilShrink = state.ring.phase === 'warn' ? config.warnTicks - state.ring.phaseTicks : 0
  const ticksUntilShrinkNorm = ticksUntilShrink / Math.max(1, config.warnTicks)
  const inRingFlag = worldDistBetween(selfWorldPos, centerWorldPos) <= state.ring.activeRadius ? 1 : 0
  // ユーザー要望: 予告リング(次に収縮する先)への自己相対位置も観測に含める。以前は現在の
  // リングの情報しか無く、方策が「今リングの外にいるか」しか知覚できず、動くリングへの先回りが
  // できなかった(§8で開示済みの`ring.nextCenter`/`nextRadius`を使うだけなので、観測を作る
  // 側の追加情報であり、simのルール自体は変えていない)。
  const nextCenterWorldPos = world(state.nodes[state.ring.nextCenter])
  const relToNextCenter = [
    (selfWorldPos.x - nextCenterWorldPos.x) / mapScale,
    (selfWorldPos.y - nextCenterWorldPos.y) / mapScale,
  ]
  const nextRingRadiusNorm = state.ring.nextRadius / mapScale
  const hpNorm = self.hp / config.unitHP

  const directionOneHot = new Array<number>(6).fill(0)
  if (!onNode) {
    const fromNode = state.nodes[self.pos.from]
    const toNode = state.nodes[self.pos.to]
    const dirIdx = DIRECTIONS.findIndex(
      (d) => d.q === toNode.q - fromNode.q && d.r === toNode.r - fromNode.r,
    )
    if (dirIdx !== -1) directionOneHot[dirIdx] = 1
  }
  const ownerOneHot = [
    selfNode.owner === self.teamId ? 1 : 0,
    selfNode.owner !== null && selfNode.owner !== self.teamId ? 1 : 0,
    selfNode.owner === null ? 1 : 0,
  ]

  const selfFeatures = [
    ...relToCenter,
    ringRadiusNorm,
    ticksUntilShrinkNorm,
    inRingFlag,
    ...relToNextCenter,
    nextRingRadiusNorm,
    selfElevation,
    hpNorm,
    onNode ? 1 : 0,
    onNode ? 0 : self.pos.progress,
    ...directionOneHot,
    ...ownerOneHot,
  ]

  // --- 味方 (unitsPerTeam - 1 スロット、ユニットID昇順で固定割り当て) ---
  const allies = state.units
    .filter((u) => u.teamId === self.teamId && u.id !== self.id)
    .sort((a, b) => a.id - b.id)
  const allyFeatures: number[] = []
  for (let i = 0; i < config.unitsPerTeam - 1; i++) {
    const ally = allies[i]
    if (!ally) {
      allyFeatures.push(0, 0, 0, 0)
      continue
    }
    const allyPos = unitWorldPos(state, ally)
    allyFeatures.push(
      (allyPos.x - selfWorldPos.x) / mapScale,
      (allyPos.y - selfWorldPos.y) / mapScale,
      ally.hp / config.unitHP,
      ally.alive ? 1 : 0,
    )
  }

  // --- 視認中の敵 (上限N体、近い順・パディング) ---
  const enemyFeatures: number[] = []
  const visibleEnemyIds: number[] = []
  for (let i = 0; i < config.maxVisibleEnemies; i++) {
    const entry = visibleEnemies[i]
    if (!entry) {
      enemyFeatures.push(0, 0, 0, 0, 0)
      visibleEnemyIds.push(-1)
      continue
    }
    const enemyPos = unitWorldPos(state, entry.unit)
    enemyFeatures.push(
      (enemyPos.x - selfWorldPos.x) / mapScale,
      (enemyPos.y - selfWorldPos.y) / mapScale,
      entry.unit.hp / config.unitHP,
      unitElevation(state, entry.unit) - selfElevation,
      entry.dist <= config.attackRange ? 1 : 0,
    )
    visibleEnemyIds.push(entry.unit.id)
  }

  // --- 局所地形パッチ (elevation, wall, owner[自/敵/中立] の5ch) ---
  const patchFeatures: number[] = []
  for (const offset of nodesInRadius(config.patchHops)) {
    const idx = nodeIndex.get(axialKey({ q: selfNode.q + offset.q, r: selfNode.r + offset.r }))
    if (idx === undefined) {
      // マップ外は壁+中立として埋める(境界付近でも常に固定長を保つ)。
      patchFeatures.push(0, 1, 0, 0, 1)
      continue
    }
    const node = state.nodes[idx]
    patchFeatures.push(
      node.elevation,
      node.passable ? 0 : 1,
      node.owner === self.teamId ? 1 : 0,
      node.owner !== null && node.owner !== self.teamId ? 1 : 0,
      node.owner === null ? 1 : 0,
    )
  }

  // --- 全体サマリ ---
  const aliveRatios = Array.from(
    { length: config.teamCount },
    (_, teamId) => state.units.filter((u) => u.teamId === teamId && u.alive).length / config.unitsPerTeam,
  )
  const passableCount = state.nodes.filter((n) => n.passable).length
  const territoryRatio =
    passableCount > 0 ? state.nodes.filter((n) => n.owner === self.teamId).length / passableCount : 0
  const stageCount = config.ringRadiusSchedule.length - 1
  const summaryFeatures = [
    ...aliveRatios,
    territoryRatio,
    state.tick / 1000,
    stageCount > 0 ? state.ring.stage / stageCount : 0,
  ]

  return {
    vector: [...selfFeatures, ...allyFeatures, ...enemyFeatures, ...patchFeatures, ...summaryFeatures],
    visibleEnemyIds,
  }
}
