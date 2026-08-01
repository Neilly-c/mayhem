import type { GameState, UnitState, Vec2 } from './types'
import { unitElevation, unitFacingVector, unitWorldPos, worldDistBetween } from './spatial'
import { withinVisionStar } from './hexgrid'

export interface CombatIntent {
  attackerId: number
  targetId: number
  damage: number
  /** ユーザー要望: `chainDamage`アビリティのクラスタ被害として与えられたダメージかどうか
   * (主攻撃はfalse/未設定)。通常攻撃と違うSEを鳴らし分けるために使う(§useSimulationLoop.ts)。 */
  chain?: boolean
}

/**
 * ユーザー要望: `damageShield`アビリティ発動中のユニットは、リングダメージ以外の被ダメージが
 * 全て`damageShieldCoef`倍される。通常攻撃(このファイル)とアビリティのAOEダメージ
 * (`abilities.ts`)の両方がここを経由することで、シールドの適用箇所を一本化する
 * (`ring.ts`のスリップダメージは意図的にこの関数を経由させない)。
 */
export function damageShieldCoefFor(target: UnitState, config: GameState['config']): number {
  if (target.ability === 'damageShield' && target.abilityActiveTicksRemaining > 0) return config.damageShieldCoef
  return 1
}

function highGroundCoef(state: GameState, elevAttacker: number, elevTarget: number): number {
  const { highGroundK, highGroundCoefMin, highGroundCoefMax } = state.config
  const raw = 1 + highGroundK * (elevAttacker - elevTarget)
  return Math.min(highGroundCoefMax, Math.max(highGroundCoefMin, raw))
}

/**
 * ユーザー要望の指向性攻撃力: 静止中は全方位に`stationaryAttackDamageCoef`(既定1.5)。移動中は
 * 進行方向(=辺のfrom→to)を基準に、対象が前方(内積>=0)なら通常(1.0)、後方なら
 * `backAttackDamageCoef`(既定0.5)。
 */
function facingDamageCoef(state: GameState, attacker: UnitState, attackerWorldPos: Vec2, targetWorldPos: Vec2): number {
  const facing = unitFacingVector(state, attacker)
  if (!facing) return state.config.stationaryAttackDamageCoef

  const towardTargetX = targetWorldPos.x - attackerWorldPos.x
  const towardTargetY = targetWorldPos.y - attackerWorldPos.y
  const dot = facing.x * towardTargetX + facing.y * towardTargetY
  return dot >= 0 ? 1 : state.config.backAttackDamageCoef
}

/**
 * ユーザー要望の過剰密集ペナルティ: メインターゲットの周囲`chainDamageRadius`以内にいる
 * (メインターゲット自身とattacker自身、attackerと同チームを除く)生存ユニット全員が対象。
 * 各ユニット自身の向き・標高・所属テリトリーは考慮せず、メインヒットの確定ダメージに
 * `chainDamageCoef`を掛けた一定倍率をそのまま適用する(「一定倍率」)。
 */
function chainDamageVictims(
  state: GameState,
  attacker: UnitState,
  target: UnitState,
  targetWorldPos: Vec2,
): UnitState[] {
  const radius = state.config.chainDamageRadius
  if (radius <= 0 || state.config.chainDamageCoef <= 0) return []
  // ユーザー要望: 連鎖ダメージは常時有効ではなく、`chainDamage`アビリティ発動中の攻撃者にのみ働く。
  if (attacker.ability !== 'chainDamage' || attacker.abilityActiveTicksRemaining <= 0) return []

  return state.units.filter(
    (u) =>
      u.alive &&
      u.id !== target.id &&
      u.id !== attacker.id &&
      u.teamId !== attacker.teamId &&
      worldDistBetween(unitWorldPos(state, u), targetWorldPos) <= radius,
  )
}

/**
 * Read phase (§7): resolves one attacker's `attackTarget` into this tick's damage events — the
 * main hit plus any chain-damage hits on enemies clustered near the target — or `[]` if the
 * attack doesn't fire this tick at all (out of range/vision, target dead, or friendly fire).
 */
export function computeCombatIntents(state: GameState, attacker: UnitState): CombatIntent[] {
  if (!attacker.alive || attacker.attackTarget === null) return []

  const target = state.units.find((u) => u.id === attacker.attackTarget)
  if (!target || !target.alive || target.teamId === attacker.teamId) return []

  const attackerWorldPos = unitWorldPos(state, attacker)
  const targetWorldPos = unitWorldPos(state, target)
  const dist = worldDistBetween(attackerWorldPos, targetWorldPos)
  if (dist > state.config.attackRange) return []
  const attackerNode = state.nodes[attacker.pos.to]
  const targetNode = state.nodes[target.pos.to]
  if (!withinVisionStar(attackerNode, targetNode, state.config.visionCoreRadius, state.config.visionSpikeRange)) return []

  const onOwnTerritory =
    attacker.pos.from === attacker.pos.to && state.nodes[attacker.pos.to].owner === attacker.teamId
  const territoryMultiplier = onOwnTerritory ? 1 + state.config.territoryAtkBonus : 1
  const highGround = highGroundCoef(state, unitElevation(state, attacker), unitElevation(state, target))
  const facing = facingDamageCoef(state, attacker, attackerWorldPos, targetWorldPos)
  const rawDamage = state.config.baseDamage * territoryMultiplier * highGround * facing

  const intents: CombatIntent[] = [
    { attackerId: attacker.id, targetId: target.id, damage: rawDamage * damageShieldCoefFor(target, state.config) },
  ]

  const chainDamage = rawDamage * state.config.chainDamageCoef
  for (const victim of chainDamageVictims(state, attacker, target, targetWorldPos)) {
    intents.push({
      attackerId: attacker.id,
      targetId: victim.id,
      damage: chainDamage * damageShieldCoefFor(victim, state.config),
      chain: true,
    })
  }

  return intents
}

/**
 * Apply phase: subtracts hp and records the attacker's team as the target's most recent damage
 * source (§撃破帰属 — used by the death-resolution phase to attribute a kill; chain-damage hits
 * update this too, so whichever combat intent lands last for this target this tick "wins",
 * consistent with the deterministic `(teamId, unitId)`-ordered application in `sim.ts`).
 * `alive` is finalized in a later, separate death-check phase (§4.2).
 */
export function applyCombatIntent(state: GameState, intent: CombatIntent): void {
  const target = state.units.find((u) => u.id === intent.targetId)
  if (!target) return
  target.hp -= intent.damage

  const attacker = state.units.find((u) => u.id === intent.attackerId)
  if (attacker) target.lastDamagedByTeamId = attacker.teamId
}
