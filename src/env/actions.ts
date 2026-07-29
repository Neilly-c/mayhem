import type { GameState, MoveCommand, UnitState } from '../sim'
import { DIRECTIONS, axialAdd } from '../sim'
import type { ActionInput, ActionMask } from './types'
import type { VisibleEnemy } from './visibility'

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

  return { move, attack }
}

/**
 * `MultiDiscrete([7, N+1])`のactionを、sim側のMoveCommand/attackTargetへデコードする。
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
): { command: MoveCommand; attackTarget: number | null } {
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

  return { command, attackTarget }
}
