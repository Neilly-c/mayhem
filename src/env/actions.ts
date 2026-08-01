import type { AbilityCommand, AbilityKind, GameState, MoveCommand, SimConfig, UnitState } from '../sim'
import { DIRECTIONS, axialAdd, hexDist, isDirectionalAbility } from '../sim'
import type { ActionInput, ActionMask } from './types'
import type { VisibleEnemy } from './visibility'

/** dirへ1ヘックス進んだ座標が地図(半径mapRadiusの正六角形、常に原点(0,0)中心 — §mapgen.ts)の
 * 内側に存在するか。狙い先ノードの通行可否までは見ない(壁越しに撃てても構わない、着弾側の
 * `abilities.ts`が塗り/ダメージそれぞれで適切に扱う)、あくまで「その方向に地図が続いているか」
 * だけの判定。 */
function directionStaysOnMap(nodeQ: number, nodeR: number, dir: number, mapRadius: number): boolean {
  const target = axialAdd({ q: nodeQ, r: nodeR }, DIRECTIONS[dir])
  return hexDist({ q: 0, r: 0 }, target) <= mapRadius
}

/** ユーザー要望: アビリティ発動ヘッドの行動マスク。装備アビリティの種類(directional/selfBuff)で
 * 意味が変わる(§ActionMask.abilityのドキュメント参照)。 */
function buildAbilityMask(state: GameState, unit: UnitState): boolean[] {
  const mask: boolean[] = [true] // 0 = 何もしないは常に合法
  const offCooldown = unit.abilityCooldownRemaining === 0

  if (isDirectionalAbility(unit.ability)) {
    const stationary = unit.pos.from === unit.pos.to
    const node = state.nodes[unit.pos.to]
    for (let dir = 0; dir < 6; dir++) {
      mask.push(offCooldown && stationary && directionStaysOnMap(node.q, node.r, dir, state.config.mapRadius))
    }
  } else {
    mask.push(offCooldown) // 1 = 発動
    for (let i = 0; i < 5; i++) mask.push(false) // 2..6は未使用
  }

  return mask
}

/** §11.3 行動マスク: 壁向きの移動、射程外/非視認/非生存な攻撃対象を無効(false)にする。
 * ユーザー要望: 同一ノードへの複数ユニット共存を禁止したため、既に他ユニットが占有(向かって)
 * いる隣接ノードへのmoveDirectionも非合法手としてマスクする — でないと、選んでも`movement.ts`
 * 側で黙って待機に化ける「選べるのに効かない行動」が生まれてしまう(以前のidle修正と同種の罠)。 */
export function buildActionMask(state: GameState, unit: UnitState, visibleEnemies: VisibleEnemy[]): ActionMask {
  const node = state.nodes[unit.pos.to]
  const move: boolean[] = [true] // 0 = その場に静止は常に合法
  for (const d of DIRECTIONS) {
    const target = axialAdd({ q: node.q, r: node.r }, d)
    const targetIdx = state.neighbors[unit.pos.to].find(
      (n) => state.nodes[n].q === target.q && state.nodes[n].r === target.r,
    )
    const occupied =
      targetIdx !== undefined && state.units.some((u) => u.alive && u.id !== unit.id && u.pos.to === targetIdx)
    move.push(targetIdx !== undefined && !occupied)
  }

  const attack: boolean[] = [true] // 0 = 攻撃しないは常に合法
  for (let i = 0; i < state.config.maxVisibleEnemies; i++) {
    const entry = visibleEnemies[i]
    attack.push(!!entry && entry.dist <= state.config.attackRange)
  }

  return { move, attack, ability: buildAbilityMask(state, unit) }
}

/** アビリティヘッドの行動値を、装備アビリティの種類に応じて`AbilityCommand`へデコードする。
 * ユーザー要望による簡略化: paintballの着弾距離はRLには選ばせず常に`paintballMaxRange`固定にする
 * (方向のみ選択) — 距離まで含めた組み合わせ数だと行動空間が過大になるため。laserはもともと
 * 固定距離(`laserRange`)なので影響しない。 */
function decodeAbilityAction(
  ability: number,
  abilityKind: AbilityKind,
  config: Pick<SimConfig, 'paintballMaxRange' | 'laserRange'>,
): AbilityCommand {
  if (!Number.isInteger(ability) || ability < 1 || ability > 6) return { type: 'none' }

  if (isDirectionalAbility(abilityKind)) {
    const range = abilityKind === 'paintball' ? config.paintballMaxRange : config.laserRange
    return { type: 'directional', dir: (ability - 1) as 0 | 1 | 2 | 3 | 4 | 5, range }
  }
  return ability === 1 ? { type: 'selfBuff' } : { type: 'none' }
}

/**
 * `MultiDiscrete([7, N+1, 7])`のactionを、sim側のMoveCommand/attackTarget/AbilityCommandへデコードする。
 *
 * ユーザー要望: move=0(待機)を`{ type: 'idle' }`ではなく`{ type: 'moveTo', node: selfNode }`
 * (現在地への`moveTo`)にデコードする。`sim/movement.ts`の`idle`は「指令未介入時のランダム探索
 * フォールバック」であり「その場に留まる」ではないため、RLの行動空間側でmove=0を選んでも実際には
 * 静止できず、`territory.ts`の敵所有ノード奪取に必要な`captureTicks`連続静止を達成できなかった。
 * `moveTo: selfNode`は`raiderBot.ts`が交戦時に「その場で静止する」ために使っているのと同じ手段
 * (自ノードへの`moveTo`は空経路→待機に解決し、`unit.destination`もそのノードに固定され続けるので、
 * 以後のtickも静止し続ける)。
 */
export function decodeAction(
  action: ActionInput,
  selfNode: number,
  visibleEnemyIds: number[],
  abilityKind: AbilityKind,
  config: Pick<SimConfig, 'paintballMaxRange' | 'laserRange'>,
): { command: MoveCommand; attackTarget: number | null; abilityCommand: AbilityCommand } {
  const move = action.move
  const command: MoveCommand =
    Number.isInteger(move) && move >= 1 && move <= 6
      ? { type: 'moveDirection', dir: (move - 1) as 0 | 1 | 2 | 3 | 4 | 5 }
      : { type: 'moveTo', node: selfNode }

  let attackTarget: number | null = null
  const attack = action.attack
  if (Number.isInteger(attack) && attack >= 1) {
    const id = visibleEnemyIds[attack - 1]
    if (id !== undefined && id !== -1) attackTarget = id
  }

  const abilityCommand = decodeAbilityAction(action.ability, abilityKind, config)

  return { command, attackTarget, abilityCommand }
}
