/** Axial hex coordinates. Cube form is derived as (x=q, z=r, y=-x-z). */
export interface AxialCoord {
  q: number
  r: number
}

export interface Vec2 {
  x: number
  y: number
}

/** ユーザー要望: ユニット単位で開始時に1種ランダム割り振られる特殊能力。同一チーム内での重複可。 */
export type AbilityKind = 'paintball' | 'laser' | 'damageShield' | 'speedBoost' | 'chainDamage'

/**
 * `command`/`attackTarget`と同じ「次の指令が来るまで持続する常設オーダー」方式(§4.2)。
 * 毎tick、クールダウン明けであれば`abilities.ts`が自動的に発動を試みる — 明示的な
 * 単発トリガーではない(狙いが外れた/対象が消えた場合は単に発動せず待つだけ)。
 * `directional`はペイントボール/レーザー用(ノード上で静止中のみ有効)、`selfBuff`は
 * ダメージシールド/スピードブースト/連鎖ダメージ用(位置を問わない)。装備している
 * `ability`の種類と一致しないtypeを送っても単に無視される(発動しない)。
 */
export type AbilityCommand =
  | { type: 'none' }
  | { type: 'directional'; dir: 0 | 1 | 2 | 3 | 4 | 5; range: number }
  | { type: 'selfBuff' }

/** ペイントボール(§`abilities.ts`)の飛行中弾。命中まで直線上を等速で進む — 途中の当たり判定は
 * 無く、`targetNode`到達時にのみ着弾処理(塗り+ダメージ)が走る。 */
export interface ProjectileState {
  id: number
  teamId: number
  ownerUnitId: number
  originNode: number
  targetNode: number
  /** 着弾までの距離(ヘックス数、発射時に射程内へクランプ済み)。 */
  distance: number
  /** ここまで進んだ距離(ヘックス単位)。`config.paintballSpeedMult * config.baseSpeed`ずつ
   * 毎tick加算され、`distance`に達した時点で着弾する。 */
  traveled: number
}

/** ユーザー要望: レーザーは即時着弾で持続状態を持たないため、発射した瞬間の見た目(光線)を
 * 数tickだけ残すための短命な表示専用オブジェクト(§`abilities.ts`/`render/draw.ts`)。ゲーム
 * ルールには一切影響しない(ダメージ/塗りは発射tickに`abilities.ts`側で即座に確定済み)。 */
export interface LaserBeamState {
  id: number
  teamId: number
  originNode: number
  /** 光線が実際に届いた直線上の最遠ノード(`laserRange`でクランプ済み)。 */
  endNode: number
  /** 表示が消えるまでの残りtick数。0になった時点で除去される。 */
  ticksRemaining: number
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
  /** 開始時にランダム割り振られ、生涯固定(§entities.ts)。 */
  ability: AbilityKind
  /** 0で発動可能。発動のたびに対応するクールダウン設定値がセットされ、以後毎tick1ずつ減る。 */
  abilityCooldownRemaining: number
  /** バフ系アビリティ(damageShield/speedBoost/chainDamage)が現在有効な残りtick数。0は非発動中。
   * paintball/laser(即時発動)では常に0のまま使わない。 */
  abilityActiveTicksRemaining: number
  /** 次tickに発動を試みる常設オーダー。`command`/`attackTarget`と同じく、bot/意思決定元が
   * 次の指令を出すまで持続する(§decisionInterval)。 */
  abilityCommand: AbilityCommand
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
   * (a penalty for clustering too tightly around a target). ユーザー要望: 常時有効だった旧仕様から、
   * `chainDamage`アビリティが発動中の攻撃者にのみ適用される仕様に変更(§combat.tsの
   * `chainDamageVictims`)。0で連鎖ダメージ無効。 */
  chainDamageRadius: number
  /** Chain damage as a fraction of the main hit's (already-modified) damage, applied uniformly to
   * every enemy caught within `chainDamageRadius` of the target. `chainDamage`アビリティのi値と
   * 兼用(既定値0.3が一致するため専用フィールドを設けず流用)。 */
  chainDamageCoef: number
  /** HP/tick regenerated while stationary on a node owned by the unit's own team. */
  territoryRegenRate: number
  /** ユーザー要望: 視野を「近傍`visionCoreRadius`ホップの正六角形」+「6方向に直線
   * `visionSpikeRange`ホップ伸びる幅1マスの棘」の二重形状にする(直線状に飛ぶペイントボール/
   * レーザーの狙い先を、その方向にだけ遠くまで見通せるようにするため)。ヘックスのホップ距離
   * (`hexgrid.ts`の`hexDist`/`withinVisionStar`)基準で、連続ワールド距離ではない
   * (`attackRange`は従来通りワールド距離のまま)。 */
  visionCoreRadius: number
  visionSpikeRange: number
  attackRange: number
  maxVisibleEnemies: number
  patchHops: number
  /** ペイントボール: 発射方向に飛ぶ弾の速度倍率(i)。`baseSpeed`基準、`abilities.ts`が毎tick
   * `paintballSpeedMult * baseSpeed`ずつ弾を進める。 */
  paintballSpeedMult: number
  /** ペイントボール: 発射方向に選べる着弾先の最大距離(j、ヘックス数)。 */
  paintballMaxRange: number
  /** ペイントボール: 着弾時、周囲7マス以内の敵に与えるダメージ(k)。 */
  paintballDamage: number
  /** ペイントボール: 発動クールダウン(n、tick)。 */
  paintballCooldown: number
  /** レーザー: 発射方向に即座に塗る/ダメージを与える直線の長さ(i、ヘックス数)。 */
  laserRange: number
  /** レーザー: 直線上の敵に与えるダメージ(j)。 */
  laserDamage: number
  /** レーザー: 発動クールダウン(k、tick)。 */
  laserCooldown: number
  /** ダメージシールド: 発動中、リングダメージ以外の被ダメージに掛かる倍率(i、既定0.7=30%軽減)。 */
  damageShieldCoef: number
  /** ダメージシールド: 効果時間(j、tick)。 */
  damageShieldDuration: number
  /** ダメージシールド: 発動クールダウン(k、tick)。 */
  damageShieldCooldown: number
  /** スピードブースト: 発動中の移動速度倍率(i)。`movement.ts`の`computeSpeed`に乗算される。 */
  speedBoostMult: number
  /** スピードブースト: 効果時間(j、tick)。 */
  speedBoostDuration: number
  /** スピードブースト: 発動クールダウン(k、tick)。 */
  speedBoostCooldown: number
  /** 連鎖ダメージ有効化: 効果時間(j、tick)。係数は`chainDamageCoef`、半径は`chainDamageRadius`を流用。 */
  chainAbilityDuration: number
  /** 連鎖ダメージ有効化: 発動クールダウン(k、tick)。 */
  chainAbilityCooldown: number
  warnTicks: number
  shrinkTicks: number
  /** World-unit safe radius per stage, e.g. [25,18,13,9,5,2,0]. Stage count = length - 1. */
  ringRadiusSchedule: number[]
  /** slipDamage[stage] = HP/tick taken while outside the safe zone during that stage. */
  slipDamage: number[]
  /** ユーザー要望: 残り1チームになった時点からゲーム終了までのカウントダウン(tick数)。
   * それまでは唯一の生存チームが自由に占領を続けられてしまうため、上限を設ける(§rules.ts)。 */
  lastTeamCountdownTicks: number
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
  /** 飛行中のペイントボール弾(§`abilities.ts`)。 */
  projectiles: ProjectileState[]
  /** `projectiles`のid採番用カウンタ(決定的なリプレイ再現のため`Date.now()`等ではなくtickごとの
   * カウンタを使う)。 */
  nextProjectileId: number
  /** 表示中のレーザー光線(§`abilities.ts`/`render/draw.ts`、ゲームルールには影響しない)。 */
  laserBeams: LaserBeamState[]
  nextLaserBeamId: number
}

/**
 * Raw per-tick outcomes from `Simulation.step()`. §11.4's reward shaping needs attacker-level
 * attribution that a before/after hp diff can't reconstruct when multiple attackers hit the same
 * target in one tick, so the sim exposes the events directly rather than making callers infer them.
 */
export interface TickEvents {
  /** `chain`: ユーザー要望。`chainDamage`アビリティのクラスタ被害として与えられたダメージなら
   * true(主攻撃/ペイントボール・レーザーのAOEダメージは未設定)。通常攻撃と違うSEを鳴らし
   * 分けるために使う(§app/useSimulationLoop.ts)。 */
  combat: { attackerId: number; targetId: number; damage: number; chain?: boolean }[]
  /** `killerTeamId`: 最後にこのユニットへ戦闘ダメージを与えた敵チーム(`lastDamagedByTeamId`の
   * 死亡時点でのスナップショット)。一度も被弾せず(リングのみで)死んだ場合はnull。 */
  deaths: { unitId: number; teamId: number; killerTeamId: number | null }[]
  eliminatedTeams: number[]
  /** Nodes whose `owner` changed as a result of this tick's territory resolution. */
  territoryCaptures: { node: number; teamId: number }[]
  /** HP regenerated by units stationary on their own team's territory. */
  regen: { unitId: number; amount: number }[]
  slipDamage: { unitId: number; damage: number }[]
  /** ユーザー要望: アビリティ発動時にSEを鳴らすためのイベントフィード(§`app/useSimulationLoop.ts`)。
   * 発動が成立した(クールダウン明け・狙い先が地図内に存在した等)ものだけを含む。 */
  abilityActivations: { unitId: number; teamId: number; kind: AbilityKind }[]
  /** ユーザー要望: ペイントボールが着弾した瞬間(発射tickとは別、§`app/useSimulationLoop.ts`の
   * スプラッシュ音用)。 */
  paintballImpacts: { unitId: number; teamId: number; node: number }[]
}
