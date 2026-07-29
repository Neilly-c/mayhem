import type { GameState, Vec2 } from '../sim'
import { world } from '../sim'

export interface Camera {
  scale: number
  offsetX: number
  offsetY: number
}

/**
 * マップ半径は1エピソード中不変なので、リセット時に1回だけ計算すればよい。毎フレームは
 * `worldToScreen`の単純な線形変換のみ。`worldPaddingY`はユーザー要望: 表示領域の上下に
 * マス1つ分(既定1.0 world単位=辺長1つ分)の余白を確保し、端のノードが画面端に張り付かないようにする。
 */
export function fitCamera(
  state: GameState,
  canvasWidth: number,
  canvasHeight: number,
  padding = 20,
  worldPaddingY = 1.0,
): Camera {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const node of state.nodes) {
    const w = world(node)
    if (w.x < minX) minX = w.x
    if (w.x > maxX) maxX = w.x
    if (w.y < minY) minY = w.y
    if (w.y > maxY) maxY = w.y
  }
  minY -= worldPaddingY
  maxY += worldPaddingY

  const worldWidth = maxX - minX || 1
  const worldHeight = maxY - minY || 1
  const availableWidth = Math.max(1, canvasWidth - padding * 2)
  const availableHeight = Math.max(1, canvasHeight - padding * 2)
  const scale = Math.min(availableWidth / worldWidth, availableHeight / worldHeight)

  const worldCenterX = (minX + maxX) / 2
  const worldCenterY = (minY + maxY) / 2

  return {
    scale,
    offsetX: canvasWidth / 2 - worldCenterX * scale,
    offsetY: canvasHeight / 2 - worldCenterY * scale,
  }
}

export function worldToScreen(camera: Camera, pos: Vec2): Vec2 {
  return { x: pos.x * camera.scale + camera.offsetX, y: pos.y * camera.scale + camera.offsetY }
}

export function screenToWorld(camera: Camera, pos: Vec2): Vec2 {
  return { x: (pos.x - camera.offsetX) / camera.scale, y: (pos.y - camera.offsetY) / camera.scale }
}
