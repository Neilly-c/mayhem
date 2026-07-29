import type { GameState, MoveCommand, UnitState, Vec2 } from '../sim'
import { DIRECTIONS, axialAdd, world } from '../sim'

/**
 * 現在ノードの6近傍のうち`scoreCandidate`が最大のものへ1歩移動する(`moveDirection`)。壁/地図端で
 * 候補が無ければ`idle`にフォールバック。辺の途中(mid-edge)の間は`moveDirection`は無視される
 * (movement.tsの仕様)ため、無害な`dir:0`をそのまま返して現在の辺の進行を妨げない
 * (`idle`を返すと、destinationが無い場合にsimの探索フォールバックが誤って発火してしまうため使わない)。
 * scriptedBot/decisionTreeBotの両方が共有する(リング退避・追跡・退避などの「方向へ1歩」判断)。
 */
export function pickBestDirection(
  state: GameState,
  unit: UnitState,
  scoreCandidate: (candidateWorldPos: Vec2) => number,
): MoveCommand {
  if (unit.pos.from !== unit.pos.to) return { type: 'moveDirection', dir: 0 }

  const node = state.nodes[unit.pos.to]
  let bestDir: 0 | 1 | 2 | 3 | 4 | 5 | null = null
  let bestScore = -Infinity

  for (let dir = 0; dir <= 5; dir++) {
    const target = axialAdd({ q: node.q, r: node.r }, DIRECTIONS[dir])
    const neighborIdx = state.neighbors[unit.pos.to].find(
      (n) => state.nodes[n].q === target.q && state.nodes[n].r === target.r,
    )
    if (neighborIdx === undefined) continue

    const score = scoreCandidate(world(state.nodes[neighborIdx]))
    if (score > bestScore) {
      bestScore = score
      bestDir = dir as 0 | 1 | 2 | 3 | 4 | 5
    }
  }

  return bestDir !== null ? { type: 'moveDirection', dir: bestDir } : { type: 'idle' }
}
