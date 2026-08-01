import type { AbilityCommand, AbilityKind, AxialCoord, GameState, NodeState, ProjectileState, UnitState } from './types'
import { DIRECTIONS, axialAdd, axialKey } from './hexgrid'
import { damageShieldCoefFor, type CombatIntent } from './combat'

/** ユーザー要望: レーザーの表示用光線(§types.tsの`LaserBeamState`)を、発動から何tick表示し続けるか。
 * ゲームルールには影響しない純粋な表示パラメータなのでconfig化はしていない。`render/draw.ts`が
 * フェードアウトの分母として参照するためexportする。 */
export const LASER_BEAM_DISPLAY_TICKS = 8

/** paintball/laserは方向+(必要なら距離)を狙って撃つ即時〜短時間発動型。damageShield/speedBoost/
 * chainDamageは位置を問わない自己バフ型。§env/actions.tsの行動マスク・decodeAction、
 * §env/observation.tsの正規化、両方が「装備アビリティの種類でどちらの発動様式か」を知る必要が
 * あるため、ここに一箇所だけ定義してsim/index.ts経由で共有する。 */
export function isDirectionalAbility(kind: AbilityKind): boolean {
  return kind === 'paintball' || kind === 'laser'
}

/** そのアビリティの発動クールダウン設定値(config.tsの対応フィールド)。§observation.tsの
 * クールダウン正規化(残り/最大)に使う。 */
export function maxCooldownFor(config: GameState['config'], kind: AbilityKind): number {
  switch (kind) {
    case 'paintball':
      return config.paintballCooldown
    case 'laser':
      return config.laserCooldown
    case 'damageShield':
      return config.damageShieldCooldown
    case 'speedBoost':
      return config.speedBoostCooldown
    case 'chainDamage':
      return config.chainAbilityCooldown
  }
}

/** バフ系アビリティの効果時間設定値。paintball/laserは持続を持たないため常に0。 */
export function maxDurationFor(config: GameState['config'], kind: AbilityKind): number {
  switch (kind) {
    case 'paintball':
    case 'laser':
      return 0
    case 'damageShield':
      return config.damageShieldDuration
    case 'speedBoost':
      return config.speedBoostDuration
    case 'chainDamage':
      return config.chainAbilityDuration
  }
}

export interface AbilityResolution {
  /** `combat.ts`の`CombatIntent`と同じ形状。`sim.ts`が通常戦闘のintentsと合流させ、同じ
   * `applyCombatIntent`ループで適用する(報酬/撃破帰属/サウンドの経路を一本化するため)。 */
  damageIntents: CombatIntent[]
  /** `territory.ts`の`resolveTerritory`と同じ形状。塗り即時奪取したノード(奪還含む)。 */
  captures: { node: number; teamId: number }[]
  /** ユーザー要望: 発動が成立したアビリティ(§SE用)。 */
  activations: { unitId: number; teamId: number; kind: AbilityKind }[]
  /** ユーザー要望: ペイントボールが着弾した瞬間(§SEのスプラッシュ音用、発射時の`activations`
   * とは別の、着弾という別tickで起こりうるイベント)。 */
  paintballImpacts: { unitId: number; teamId: number; node: number }[]
}

function buildAxialIndex(nodes: readonly NodeState[]): Map<string, number> {
  const index = new Map<string, number>()
  nodes.forEach((n, i) => index.set(axialKey(n), i))
  return index
}

function walkDirection(origin: AxialCoord, dir: number, hops: number): AxialCoord {
  let cur: AxialCoord = { q: origin.q, r: origin.r }
  for (let i = 0; i < hops; i++) cur = axialAdd(cur, DIRECTIONS[dir])
  return cur
}

/** origin から dir 方向へ最大maxHopsまで歩き、地図内に存在する最も遠いノードを返す(§ペイントボール
 * の着弾先選択、地図端では要求距離をクランプする)。1ホップも地図内に無ければnull。 */
function farthestValidNode(
  index: Map<string, number>,
  origin: AxialCoord,
  dir: number,
  maxHops: number,
): { nodeIdx: number; hops: number } | null {
  let best: { nodeIdx: number; hops: number } | null = null
  for (let hops = 1; hops <= maxHops; hops++) {
    const idx = index.get(axialKey(walkDirection(origin, dir, hops)))
    if (idx === undefined) break
    best = { nodeIdx: idx, hops }
  }
  return best
}

/** origin から dir 方向へ1ホップ目からmaxHopsまで、地図内に存在する全ノードを順に返す
 * (§レーザーの直線塗り、地図端に達したら打ち切り)。 */
function lineNodes(index: Map<string, number>, origin: AxialCoord, dir: number, maxHops: number): number[] {
  const result: number[] = []
  for (let hops = 1; hops <= maxHops; hops++) {
    const idx = index.get(axialKey(walkDirection(origin, dir, hops)))
    if (idx === undefined) break
    result.push(idx)
  }
  return result
}

/** 対象ノード群を即座にteamId色へ塗る(`captureTicks`の滞在判定をバイパスする瞬間奪取)。壁
 * (非passable)は所有権の概念が無いので読み飛ばす。実際に所有者が変わったノードだけ`captures`
 * に記録する(既に自チーム所有のノードを再度塗っても記録しない)。 */
function paintNodes(
  state: GameState,
  nodeIndices: readonly number[],
  teamId: number,
  captures: { node: number; teamId: number }[],
): void {
  for (const idx of nodeIndices) {
    const node = state.nodes[idx]
    if (!node.passable) continue
    if (node.owner !== teamId) captures.push({ node: idx, teamId })
    node.owner = teamId
    node.captureProgress = null
  }
}

/** 対象ノード群の上にいる(`pos.from`または`pos.to`が含まれる)敵ユニット全員にダメージを与える。
 * `damageShield`発動中の対象は`damageShieldCoefFor`で軽減する(通常攻撃と同じ経路)。 */
function damageEnemiesInArea(
  state: GameState,
  nodeIndices: readonly number[],
  casterTeamId: number,
  casterUnitId: number,
  rawDamage: number,
  damageIntents: CombatIntent[],
): void {
  const area = new Set(nodeIndices)
  for (const victim of state.units) {
    if (!victim.alive || victim.teamId === casterTeamId) continue
    if (!area.has(victim.pos.from) && !area.has(victim.pos.to)) continue
    damageIntents.push({
      attackerId: casterUnitId,
      targetId: victim.id,
      damage: rawDamage * damageShieldCoefFor(victim, state.config),
    })
  }
}

/** ペイントボール着弾処理: 着弾ノード+周囲6マス(=最大7マス)を塗り、範囲内の敵にダメージ。
 * 飛行中に発射者が死亡していても、`teamId`/`ownerUnitId`は発射時点のまま着弾処理される
 * (`applyCombatIntent`は発射者が既に存在しなければ撃破帰属の更新だけ黙って諦める)。 */
function resolvePaintballImpact(
  state: GameState,
  index: Map<string, number>,
  projectile: ProjectileState,
  captures: { node: number; teamId: number }[],
  damageIntents: CombatIntent[],
  paintballImpacts: { unitId: number; teamId: number; node: number }[],
): void {
  const targetNode = state.nodes[projectile.targetNode]
  const area = [projectile.targetNode]
  for (const dir of DIRECTIONS) {
    const idx = index.get(axialKey(axialAdd(targetNode, dir)))
    if (idx !== undefined) area.push(idx)
  }
  paintNodes(state, area, projectile.teamId, captures)
  damageEnemiesInArea(state, area, projectile.teamId, projectile.ownerUnitId, state.config.paintballDamage, damageIntents)
  paintballImpacts.push({ unitId: projectile.ownerUnitId, teamId: projectile.teamId, node: projectile.targetNode })
}

function activatePaintball(
  state: GameState,
  index: Map<string, number>,
  unit: UnitState,
  command: Extract<AbilityCommand, { type: 'directional' }>,
  activations: { unitId: number; teamId: number; kind: AbilityKind }[],
): void {
  const origin = state.nodes[unit.pos.to]
  const maxRange = Math.max(1, Math.min(command.range, state.config.paintballMaxRange))
  const found = farthestValidNode(index, origin, command.dir, maxRange)
  if (!found) return // その方向に地図内のノードが無い: 発動失敗、クールダウンは消費しない

  state.projectiles.push({
    id: state.nextProjectileId++,
    teamId: unit.teamId,
    ownerUnitId: unit.id,
    originNode: unit.pos.to,
    targetNode: found.nodeIdx,
    distance: found.hops,
    traveled: 0,
  })
  unit.abilityCooldownRemaining = state.config.paintballCooldown
  activations.push({ unitId: unit.id, teamId: unit.teamId, kind: 'paintball' })
}

function activateLaser(
  state: GameState,
  index: Map<string, number>,
  unit: UnitState,
  command: Extract<AbilityCommand, { type: 'directional' }>,
  captures: { node: number; teamId: number }[],
  damageIntents: CombatIntent[],
  activations: { unitId: number; teamId: number; kind: AbilityKind }[],
): void {
  const origin = state.nodes[unit.pos.to]
  const line = lineNodes(index, origin, command.dir, state.config.laserRange)
  if (line.length === 0) return // その方向に地図内のノードが無い: 発動失敗、クールダウンは消費しない

  paintNodes(state, line, unit.teamId, captures)
  damageEnemiesInArea(state, line, unit.teamId, unit.id, state.config.laserDamage, damageIntents)
  unit.abilityCooldownRemaining = state.config.laserCooldown
  activations.push({ unitId: unit.id, teamId: unit.teamId, kind: 'laser' })

  // ユーザー要望: レーザーは即時着弾でゲーム状態には何も残らないため、光線を数tickだけ表示する
  // 純粋に見た目のためのオブジェクトを残す(ゲームルールには一切影響しない)。
  state.laserBeams.push({
    id: state.nextLaserBeamId++,
    teamId: unit.teamId,
    originNode: unit.pos.to,
    endNode: line[line.length - 1],
    ticksRemaining: LASER_BEAM_DISPLAY_TICKS,
  })
}

function activateSelfBuff(
  state: GameState,
  unit: UnitState,
  activations: { unitId: number; teamId: number; kind: AbilityKind }[],
): void {
  const config = state.config
  if (unit.ability === 'damageShield') {
    unit.abilityActiveTicksRemaining = config.damageShieldDuration
    unit.abilityCooldownRemaining = config.damageShieldCooldown
  } else if (unit.ability === 'speedBoost') {
    unit.abilityActiveTicksRemaining = config.speedBoostDuration
    unit.abilityCooldownRemaining = config.speedBoostCooldown
  } else if (unit.ability === 'chainDamage') {
    unit.abilityActiveTicksRemaining = config.chainAbilityDuration
    unit.abilityCooldownRemaining = config.chainAbilityCooldown
  } else {
    return // paintball/laserユニットが誤って`selfBuff`を送ってきた場合は何もしない(無効な組み合わせ)。
  }
  activations.push({ unitId: unit.id, teamId: unit.teamId, kind: unit.ability })
}

/**
 * Read+Apply phase (§4.2に準ずる新フェーズ、combat直後に実行): 各ユニットの`abilityCommand`
 * (`command`/`attackTarget`と同じ「次の指令まで持続する常設オーダー」)を解決する。
 *
 * 1. 全生存ユニットのクールダウン/効果時間を毎tick1ずつ減らす。
 * 2. 飛行中のペイントボール弾を進め、着弾したものを処理する。
 * 3. `order`(teamId,unitId昇順、`sim.ts`の他フェーズと同じ決定的順序)に沿って新規発動要求を
 *    処理する — クールダウン明けかつ、`directional`はノード上で静止中の場合のみ発動する。
 */
export function resolveAbilities(state: GameState, order: readonly UnitState[]): AbilityResolution {
  const damageIntents: CombatIntent[] = []
  const captures: { node: number; teamId: number }[] = []
  const activations: { unitId: number; teamId: number; kind: AbilityKind }[] = []
  const paintballImpacts: { unitId: number; teamId: number; node: number }[] = []

  for (const unit of state.units) {
    if (!unit.alive) continue
    if (unit.abilityCooldownRemaining > 0) unit.abilityCooldownRemaining--
    if (unit.abilityActiveTicksRemaining > 0) unit.abilityActiveTicksRemaining--
  }

  const index = buildAxialIndex(state.nodes)

  const stillFlying: ProjectileState[] = []
  for (const projectile of state.projectiles) {
    projectile.traveled += state.config.paintballSpeedMult * state.config.baseSpeed
    if (projectile.traveled < projectile.distance) {
      stillFlying.push(projectile)
      continue
    }
    resolvePaintballImpact(state, index, projectile, captures, damageIntents, paintballImpacts)
  }
  state.projectiles = stillFlying

  // 表示専用のレーザー光線を減衰させる(ゲームルールには影響しない)。
  state.laserBeams = state.laserBeams
    .map((beam) => ({ ...beam, ticksRemaining: beam.ticksRemaining - 1 }))
    .filter((beam) => beam.ticksRemaining > 0)

  for (const unit of order) {
    if (!unit.alive || unit.abilityCooldownRemaining > 0) continue
    const command = unit.abilityCommand
    if (command.type === 'none') continue

    if (command.type === 'directional') {
      if (unit.pos.from !== unit.pos.to) continue // ノード上で静止中のみ発動可能
      if (unit.ability === 'paintball') activatePaintball(state, index, unit, command, activations)
      else if (unit.ability === 'laser') activateLaser(state, index, unit, command, captures, damageIntents, activations)
      // buff系ユニットが誤って`directional`を送ってきた場合は何もしない(無効な組み合わせ)。
    } else {
      activateSelfBuff(state, unit, activations)
    }
  }

  return { damageIntents, captures, activations, paintballImpacts }
}
