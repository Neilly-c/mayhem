/** Axial hex coordinates. Cube form is derived as (x=q, z=r, y=-x-z). */
export interface AxialCoord {
  q: number
  r: number
}

export interface Vec2 {
  x: number
  y: number
}

export interface NodeState {
  q: number
  r: number
  elevation: number
  passable: boolean
  owner: number | null
  captureProgress: { teamId: number; ticks: number } | null
}

/**
 * Movement portion of a unit's command. Kept separate from the attack target because §11.3's
 * action space fires both simultaneously each decision (`MultiDiscrete([7, N+1])`), not as
 * mutually-exclusive alternatives.
 */
export type MoveCommand =
  | { type: 'idle' }
  | { type: 'moveDirection'; dir: 0 | 1 | 2 | 3 | 4 | 5 }
  | { type: 'moveTo'; node: number }

export interface UnitPosition {
  /** Node index the unit is departing from (== `to` when stationary on a node). */
  from: number
  /** Node index the unit is heading to (== `from` when stationary on a node). */
  to: number
  /** Fraction of the edge traversed, in [0, 1]. 0 when stationary on a node. */
  progress: number
}

export interface UnitState {
  id: number
  teamId: number
  pos: UnitPosition
  hp: number
  alive: boolean
  command: MoveCommand
  /** Unit id being attacked this tick, or null. No-op until Phase 2 combat. */
  attackTarget: number | null
  destination: number | null
  /** Cached remaining path (node indices) *after* `pos.to`, closest hop first. */
  path: number[] | null
  /** ユーザー要望: 撃破の帰属判定用。直近に戦闘ダメージ(チェイン含む)を与えてきた敵チームのID。
   * リング外スリップダメージ(`ring.ts`)はチームの行為ではないため更新しない — このユニットが
   * 最後に敵と交戦した後にリングだけで力尽きても、帰属は変わらずその敵チームのまま。一度も
   * 被弾せず死ぬ(スリップのみで死亡)場合はnullのまま=誰の撃破にもならない。 */
  lastDamagedByTeamId: number | null
}

export interface TeamState {
  id: number
  alive: boolean
  /** Tick at which this team's last unit died, or null while still alive. Not derivable after the fact. */
  eliminatedAtTick: number | null
  /** ユーザー要望: 敵ユニットの撃破数(ダメージ量やリングダメージの有無を問わず、各死亡ユニットの
   * `lastDamagedByTeamId`を1件ずつ加算)。チーム全滅への追加ボーナスはなく、これは撃破数の
   * 単純な累計。 */
  killCount: number
}

/** §6 係争ノード(複数チームが同一ノードに同時滞在)時の挙動。 */
export type ContestedCaptureBehavior = 'freeze' | 'reset'

export interface SimConfig {
  mapRadius: number
  wallThreshold: number
  perlinFrequency: number
  teamCount: number
  unitsPerTeam: number
  unitHP: number
  baseSpeed: number
  territoryMoveBonus: number
  decisionInterval: number
  captureTicks: number
  contestedCaptureBehavior: ContestedCaptureBehavior
  territoryAtkBonus: number
  baseDamage: number
  highGroundK: number
  highGroundCoefMin: number
  highGroundCoefMax: number
  /** Damage multiplier when the target is behind the attacker's facing direction (front stays 1x). */
  backAttackDamageCoef: number
  /** Damage multiplier applied in every direction while the attacker is stationary on a node. */
  stationaryAttackDamageCoef: number
  /** World-distance radius around the main attack target within which other enemies take chain damage
   * (a penalty for clustering too tightly around a target). 0 disables chain damage entirely. */
  chainDamageRadius: number
  /** Chain damage as a fraction of the main hit's (already-modified) damage, applied uniformly to
   * every enemy caught within `chainDamageRadius` of the target. */
  chainDamageCoef: number
  /** HP/tick regenerated while stationary on a node owned by the unit's own team. */
  territoryRegenRate: number
  visionRange: number
  attackRange: number
  maxVisibleEnemies: number
  patchHops: number
  warnTicks: number
  shrinkTicks: number
  /** World-unit safe radius per stage, e.g. [25,18,13,9,5,2,0]. Stage count = length - 1. */
  ringRadiusSchedule: number[]
  /** slipDamage[stage] = HP/tick taken while outside the safe zone during that stage. */
  slipDamage: number[]
}

export interface RingState {
  /** Index into `ringRadiusSchedule` for the currently-active safe zone. */
  stage: number
  phase: 'warn' | 'shrink' | 'done'
  phaseTicks: number
  /** Continuous world-space center of the current safe zone. Fixed during 'warn', moves at
   * constant velocity toward `nextCenter` during 'shrink'. */
  centerWorld: Vec2
  activeRadius: number
  /** Snapshot of `centerWorld` at the moment the current shrink began; the lerp start point. */
  shrinkStartCenter: Vec2
  /** Disclosed to units per §8: only the *next* shrink's center/radius, nothing further. */
  nextCenter: number
  nextRadius: number
}

export interface GameState {
  seed: number
  tick: number
  config: SimConfig
  nodes: NodeState[]
  /** neighbors[i] = indices of passable nodes adjacent to node i. Same length/order as `nodes`. */
  neighbors: number[][]
  teams: TeamState[]
  units: UnitState[]
  ring: RingState
}

/**
 * Raw per-tick outcomes from `Simulation.step()`. §11.4's reward shaping needs attacker-level
 * attribution that a before/after hp diff can't reconstruct when multiple attackers hit the same
 * target in one tick, so the sim exposes the events directly rather than making callers infer them.
 */
export interface TickEvents {
  combat: { attackerId: number; targetId: number; damage: number }[]
  /** `killerTeamId`: 最後にこのユニットへ戦闘ダメージを与えた敵チーム(`lastDamagedByTeamId`の
   * 死亡時点でのスナップショット)。一度も被弾せず(リングのみで)死んだ場合はnull。 */
  deaths: { unitId: number; teamId: number; killerTeamId: number | null }[]
  eliminatedTeams: number[]
  /** Nodes whose `owner` changed as a result of this tick's territory resolution. */
  territoryCaptures: { node: number; teamId: number }[]
  /** HP regenerated by units stationary on their own team's territory. */
  regen: { unitId: number; amount: number }[]
  slipDamage: { unitId: number; damage: number }[]
}
