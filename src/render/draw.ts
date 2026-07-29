import type { GameState, UnitState, Vec2 } from '../sim'
import { axialKey, nodesInRadius, unitFacingVector, unitWorldPos, world } from '../sim'
import type { Camera } from './camera'
import { worldToScreen } from './camera'
import {
  ATTACK_LINE_COLOR,
  ATTACK_RANGE_COLOR,
  FACING_INDICATOR_FILL,
  FACING_INDICATOR_STROKE,
  PATCH_HIGHLIGHT_COLOR,
  RING_BOUNDARY_COLOR,
  RING_DANGER_FILL,
  RING_NEXT_BOUNDARY_COLOR,
  VISION_RANGE_COLOR,
  WALL_COLOR,
  elevationColor,
  teamColor,
} from './colors'

export interface DrawOptions {
  showVision: boolean
  showAttackRange: boolean
  showPatch: boolean
  selectedUnitId: number | null
}

const UNIT_RADIUS_FRACTION = 0.35

/**
 * ユーザー要望: ノードを隙間なく敷き詰めた正六角形にする。`hexgrid.ts`の`world()`(pointy-top、
 * 隣接ノード間距離は常に1.0)に対して、中心から頂点までの半径Rが `R*sqrt(3) = 1.0` を満たせば
 * 隣接六角形同士がぴったり辺を共有し、隙間もオーバーラップも生じない(R = 1/√3)。頂点は隣接方向
 * (60°刻み、0°始まり)から30°回転した角度(30°,90°,...,330°)に立つ — 隣接ノードへの方向は
 * 六角形の辺の中点(=頂点と頂点のちょうど中間)を向く必要があるため。
 */
const HEX_CIRCUMRADIUS_FRACTION = 1 / Math.sqrt(3)
const HEX_VERTEX_OFFSETS: readonly Vec2[] = Array.from({ length: 6 }, (_, k) => {
  const angle = Math.PI / 6 + (k * Math.PI) / 3
  return { x: Math.cos(angle), y: Math.sin(angle) }
})

function hexPath(ctx: CanvasRenderingContext2D, center: Vec2, circumradius: number): void {
  ctx.beginPath()
  for (let k = 0; k < 6; k++) {
    const offset = HEX_VERTEX_OFFSETS[k]
    const x = center.x + offset.x * circumradius
    const y = center.y + offset.y * circumradius
    if (k === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** §12 神視点の1frame描画。simの状態スナップショットを読むだけで、ロジックは持たない。 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: Camera,
  options: DrawOptions,
): void {
  const canvas = ctx.canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  drawNodes(ctx, state, camera)
  // ユーザー要望: リング外は個々のノードにではなく、圏外全体に一様な赤の重ね塗りをする。
  // ノードを描いた後に重ねることで、地形の上に途切れなく赤が乗る(ノード円の下に隠れない)。
  drawRingDanger(ctx, state, camera)
  drawRingBoundaries(ctx, state, camera)
  if (options.showPatch && options.selectedUnitId !== null) {
    drawObservationPatch(ctx, state, camera, options.selectedUnitId)
  }
  drawAttackLines(ctx, state, camera)
  drawUnits(ctx, state, camera, options.selectedUnitId)
  if (options.selectedUnitId !== null) {
    drawUnitOverlays(ctx, state, camera, options)
  }
}

function drawNodes(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera): void {
  const circumradius = Math.max(1, camera.scale * HEX_CIRCUMRADIUS_FRACTION)
  for (const node of state.nodes) {
    const screen = worldToScreen(camera, world(node))
    hexPath(ctx, screen, circumradius)
    ctx.fillStyle = node.passable ? elevationColor(node.elevation) : WALL_COLOR
    ctx.fill()
    if (node.passable && node.owner !== null) {
      ctx.fillStyle = teamColor(node.owner, 0.35)
      ctx.fill()
    }
  }
}

let ringDangerOverlay: HTMLCanvasElement | null = null

function drawRingDanger(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera): void {
  const canvas = ctx.canvas
  const center = worldToScreen(camera, state.ring.centerWorld)
  const radius = state.ring.activeRadius * camera.scale

  // `destination-out`はメインキャンバスに直接使うと、そのキャンバスに既に描かれた内容
  // (drawNodesのノードなど)まで巻き込んで消してしまう(バグの原因: リング内のノードが消える)。
  // オフスクリーンキャンバス上でオーバーレイを完成させてから、通常合成でメインに一度だけ重ねる。
  if (!ringDangerOverlay) ringDangerOverlay = document.createElement('canvas')
  if (ringDangerOverlay.width !== canvas.width) ringDangerOverlay.width = canvas.width
  if (ringDangerOverlay.height !== canvas.height) ringDangerOverlay.height = canvas.height
  const octx = ringDangerOverlay.getContext('2d')
  if (!octx) return

  octx.clearRect(0, 0, ringDangerOverlay.width, ringDangerOverlay.height)
  // `destination-out`は前フレームの後始末をしないと次フレームに持ち越る(octxは使い回しの
  // 永続コンテキストなので、globalCompositeOperationがリセットされずに残る)。clearRectは
  // compositeOperationを無視して常に透明化するが、直後のfillRectは前フレームのdestination-out
  // のまま実行されてしまい、透明なキャンバスに対しては何も描かれない(バグの原因: 2フレーム目
  // 以降、赤いオーバーレイが完全に消える)。塗りつぶし前に必ずsource-overへ戻す。
  octx.globalCompositeOperation = 'source-over'
  octx.fillStyle = RING_DANGER_FILL
  octx.fillRect(0, 0, ringDangerOverlay.width, ringDangerOverlay.height)
  octx.globalCompositeOperation = 'destination-out'
  // `destination-out`はソースのアルファ値に比例して消す。RING_DANGER_FILLの半透明のまま
  // 消去円を描くと安全圏内にも赤が薄く残ってしまう(バグの原因)ため、消去だけは不透明色で行う。
  octx.fillStyle = 'rgba(0,0,0,1)'
  octx.beginPath()
  octx.arc(center.x, center.y, Math.max(0, radius), 0, Math.PI * 2)
  octx.fill()

  ctx.drawImage(ringDangerOverlay, 0, 0)
}

function drawRingBoundaries(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera): void {
  const ring = state.ring
  const center = worldToScreen(camera, ring.centerWorld)

  ctx.save()
  ctx.strokeStyle = RING_BOUNDARY_COLOR
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(center.x, center.y, Math.max(0, ring.activeRadius * camera.scale), 0, Math.PI * 2)
  ctx.stroke()

  if (ring.phase === 'warn') {
    const nextCenter = worldToScreen(camera, world(state.nodes[ring.nextCenter]))
    ctx.strokeStyle = RING_NEXT_BOUNDARY_COLOR
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.arc(nextCenter.x, nextCenter.y, Math.max(0, ring.nextRadius * camera.scale), 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function drawAttackLines(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera): void {
  ctx.save()
  ctx.strokeStyle = ATTACK_LINE_COLOR
  ctx.lineWidth = 1.5
  for (const unit of state.units) {
    if (!unit.alive || unit.attackTarget === null) continue
    const target = state.units.find((u) => u.id === unit.attackTarget)
    if (!target || !target.alive) continue
    const from = worldToScreen(camera, unitWorldPos(state, unit))
    const to = worldToScreen(camera, unitWorldPos(state, target))
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * ユーザー要望: ユニットの向きを可視化する。移動中は進行方向(§7の指向性攻撃力と同じ向き)。
 * 静止中は本来向きを持たないが、攻撃対象がいれば表示上の便宜としてその方向を向かせる。
 */
function unitDisplayFacing(state: GameState, unit: UnitState): Vec2 | null {
  const facing = unitFacingVector(state, unit)
  if (facing) return facing

  if (unit.attackTarget !== null) {
    const target = state.units.find((u) => u.id === unit.attackTarget)
    if (target && target.alive) {
      const selfPos = unitWorldPos(state, unit)
      const targetPos = unitWorldPos(state, target)
      return { x: targetPos.x - selfPos.x, y: targetPos.y - selfPos.y }
    }
  }
  return null
}

function drawFacingIndicator(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  facing: Vec2,
  unitRadius: number,
): void {
  const len = Math.hypot(facing.x, facing.y)
  if (len < 1e-9) return
  const dirX = facing.x / len
  const dirY = facing.y / len
  const perpX = -dirY
  const perpY = dirX

  const tip = { x: center.x + dirX * unitRadius * 1.6, y: center.y + dirY * unitRadius * 1.6 }
  const baseX = center.x + dirX * unitRadius * 0.6
  const baseY = center.y + dirY * unitRadius * 0.6
  const baseHalfWidth = unitRadius * 0.55

  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(baseX + perpX * baseHalfWidth, baseY + perpY * baseHalfWidth)
  ctx.lineTo(baseX - perpX * baseHalfWidth, baseY - perpY * baseHalfWidth)
  ctx.closePath()
  ctx.fillStyle = FACING_INDICATOR_FILL
  ctx.fill()
  ctx.strokeStyle = FACING_INDICATOR_STROKE
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawUnits(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: Camera,
  selectedUnitId: number | null,
): void {
  const radius = Math.max(2, camera.scale * UNIT_RADIUS_FRACTION)
  for (const unit of state.units) {
    if (!unit.alive) continue
    const screen = worldToScreen(camera, unitWorldPos(state, unit))

    ctx.beginPath()
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = teamColor(unit.teamId)
    ctx.fill()

    if (unit.id === selectedUnitId) {
      ctx.lineWidth = 2
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
    }

    const facing = unitDisplayFacing(state, unit)
    if (facing) drawFacingIndicator(ctx, screen, facing, radius)

    const hpFraction = Math.max(0, Math.min(1, unit.hp / state.config.unitHP))
    const barWidth = radius * 2.4
    const barHeight = Math.max(2, radius * 0.3)
    const barX = screen.x - barWidth / 2
    const barY = screen.y - radius - barHeight - 2
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(barX, barY, barWidth, barHeight)
    ctx.fillStyle = hpFraction > 0.3 ? '#4caf50' : '#e53935'
    ctx.fillRect(barX, barY, barWidth * hpFraction, barHeight)
  }
}

function drawUnitOverlays(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: Camera,
  options: DrawOptions,
): void {
  const unit = state.units.find((u) => u.id === options.selectedUnitId)
  if (!unit || !unit.alive) return
  const screen = worldToScreen(camera, unitWorldPos(state, unit))

  ctx.save()
  ctx.setLineDash([4, 4])
  if (options.showVision) {
    ctx.strokeStyle = VISION_RANGE_COLOR
    ctx.beginPath()
    ctx.arc(screen.x, screen.y, state.config.visionRange * camera.scale, 0, Math.PI * 2)
    ctx.stroke()
  }
  if (options.showAttackRange) {
    ctx.strokeStyle = ATTACK_RANGE_COLOR
    ctx.beginPath()
    ctx.arc(screen.x, screen.y, state.config.attackRange * camera.scale, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

/** §11.2の観測パッチと同じ形状(半径patchHopsホップの六角パッチ)を選択ユニット中心にハイライトする。 */
function drawObservationPatch(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: Camera,
  selectedUnitId: number,
): void {
  const unit = state.units.find((u) => u.id === selectedUnitId)
  if (!unit || !unit.alive) return

  const nodeIndex = new Map<string, number>()
  state.nodes.forEach((n, i) => nodeIndex.set(axialKey(n), i))

  const selfNode = state.nodes[unit.pos.to]
  const circumradius = Math.max(1, camera.scale * HEX_CIRCUMRADIUS_FRACTION)

  ctx.save()
  ctx.fillStyle = PATCH_HIGHLIGHT_COLOR
  for (const offset of nodesInRadius(state.config.patchHops)) {
    const idx = nodeIndex.get(axialKey({ q: selfNode.q + offset.q, r: selfNode.r + offset.r }))
    if (idx === undefined) continue
    const screen = worldToScreen(camera, world(state.nodes[idx]))
    hexPath(ctx, screen, circumradius)
    ctx.fill()
  }
  ctx.restore()
}
