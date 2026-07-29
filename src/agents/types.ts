import type { GameState, MoveCommand } from '../sim'

export interface UnitDecision {
  command: MoveCommand
  attackTarget: number | null
}

/** ライブ実行・リプレイ実行のどちらも、この形の関数から「今tickの意思決定」を受け取る。 */
export type DecisionSource = (state: GameState, aliveUnitIds: number[]) => Map<number, UnitDecision>
