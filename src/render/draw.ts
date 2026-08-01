import type { AbilityKind, GameState, NodeState, UnitState, Vec2 } from '../sim'
import {
  LASER_BEAM_DISPLAY_TICKS,
  axialKey,
  lastTeamCountdownRemaining,
  nodesInRadius,
  unitElevation,
  unitFacingVector,
  unitWorldPos,
  visionStarOffsets,
  world,
} from '../sim'
import type { Camera } from './camera'
import { worldToScreen } from './camera'
import { ABILITY_SHAPES } from './abilityVisuals'
import {
  ATTACK_LINE_COLOR,
  ATTACK_RANGE_COLOR,
  CHAIN_DAMAGE_ACTIVE_COLOR,
  DAMAGE_SHIELD_ACTIVE_COLOR,
  FACING_INDICATOR_FILL,
  FACING_INDICATOR_STROKE,
  LASER_BEAM_COLOR,
  PATCH_HIGHLIGHT_COLOR,
  PROJECTILE_STROKE_COLOR,
  RING_BOUNDARY_COLOR,
  RING_DANGER_FILL,
  RING_NEXT_BOUNDARY_COLOR,
  SPEED_BOOST_ACTIVE_COLOR,
  VISION_RANGE_COLOR,
  WALL_COLOR,
  elevationColor,
  elevationSkirtColor,
  teamColor,
} from './colors'

export interface DrawOptions {
  showVision: boolean
  showAttackRange: boolean
  showPatch: boolean
  selectedUnitId: number | null
  /** ユーザー要望: 標高差を可視化する斜め見下ろし表示への切り替え。透視投影は使わず、標高に
   * 比例した画面Y方向オフセットだけを加える平行投影(遠近感の演出は不要 = perspective: none相当)。 */
  obliqueView: boolean
}

/** 標高1.0(最大)のノードが画面上で持ち上がる高さ(ワールド単位。worldToScreenのscaleでpx化される)。 */
const OBLIQUE_HEIGHT_WORLD = 1.1

/** ユーザー要望: 壁は高さ0として扱い、斜め表示で視界を邪魔しないようにする。 */
function obliqueElevation(node: NodeState): number {
  return node.passable ? node.elevation : 0
}

function obliqueYOffset(camera: Camera, elevation: number): number {
  return -(elevation - 0.5) * OBLIQUE_HEIGHT_WORLD * camera.scale * 1.8
}

/** ノードの表示位置。obliqueView時のみ標高ぶん画面上に持ち上げる。 */
function nodeScreen(camera: Camera, node: NodeState, oblique: boolean): Vec2 {
  const base = worldToScreen(camera, world(node))
  if (!oblique) return base
  return { x: base.x, y: base.y + obliqueYOffset(camera, obliqueElevation(node)) }
}

/** ユニットの表示位置。ユニットは常に通行可能ノード上にいるため壁の高さ0特例は不要。 */
function unitScreen(camera: Camera, state: GameState, unit: UnitState, oblique: boolean): Vec2 {
  const base = worldToScreen(camera, unitWorldPos(state, unit))
  if (!oblique) return base
  return { x: base.x, y: base.y + obliqueYOffset(camera, unitElevation(state, unit)) }
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

function polygonPath(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  circumradius: number,
  sides: number,
  rotation: number,
): void {
  ctx.beginPath()
  for (let k = 0; k < sides; k++) {
    const angle = rotation + (k * Math.PI * 2) / sides
    const x = center.x + Math.cos(angle) * circumradius
    const y = center.y + Math.sin(angle) * circumradius
    if (k === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function starPath(
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  outerRadius: number,
  innerRadius: number,
  points: number,
  rotation = -Math.PI / 2,
): void {
  ctx.beginPath()
  for (let k = 0; k < points * 2; k++) {
    const radius = k % 2 === 0 ? outerRadius : innerRadius
    const angle = rotation + (k * Math.PI) / points
    const x = center.x + Math.cos(angle) * radius
    const y = center.y + Math.sin(angle) * radius
    if (k === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** ユーザー要望: ユニットの形状を割り振られたアビリティごとに変える(区別しやすくするため)。
 * パスを構築するだけで塗り/縁取りは呼び出し側(`drawUnits`)に任せる — 選択中ユニットの白枠は
 * 同じパスを`fill`直後に`stroke`し直すことで実現している(`beginPath`を挟まないため)。 */
function unitShapePath(ctx: CanvasRenderingContext2D, ability: AbilityKind, center: Vec2, radius: number): void {
  switch (ABILITY_SHAPES[ability]) {
    case 'circle':
      ctx.beginPath()
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
      return
    case 'triangle':
      polygonPath(ctx, center, radius * 1.2, 3, -Math.PI / 2)
      return
    case 'hexagon':
      polygonPath(ctx, center, radius * 1.05, 6, -Math.PI / 2)
      return
    case 'diamond':
      polygonPath(ctx, center, radius * 1.2, 4, -Math.PI / 2)
      return
    case 'star':
      starPath(ctx, center, radius * 1.3, radius * 0.55, 5)
      return
  }
}

/**
 * ユーザー要望: バフ系アビリティ(damageShield/speedBoost/chainDamage)発動中の見た目を、
 * 種類ごとに完全に分ける(以前は共通の白い点線の輪1種類だけだった)。`tick`を使ってアニメ
 * させるための追加の状態は持たない(決定的な`state.tick`をそのまま位相に使うだけ)。
 * - damageShield: 動かない二重の同心円(バリアの膜のような安定した見た目)。
 * - speedBoost: 高速に流れて見える点線の輪(`lineDashOffset`を`tick`で動かす)。
 * - chainDamage: ギザギザの稲妻状の輪(`starPath`を浅い凹凸で再利用)、わずかに回転させる。
 */
function drawAbilityBuffIndicator(
  ctx: CanvasRenderingContext2D,
  ability: AbilityKind,
  screen: Vec2,
  radius: number,
  tick: number,
): void {
  ctx.save()
  switch (ability) {
    case 'damageShield': {
      const pulse = 0.7 + 0.3 * Math.sin(tick / 12)
      ctx.globalAlpha = pulse
      ctx.strokeStyle = DAMAGE_SHIELD_ACTIVE_COLOR
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(screen.x, screen.y, radius * 1.45, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(screen.x, screen.y, radius * 1.8, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'speedBoost': {
      ctx.strokeStyle = SPEED_BOOST_ACTIVE_COLOR
      ctx.lineWidth = 2
      ctx.setLineDash([radius * 0.9, radius * 0.9])
      ctx.lineDashOffset = -tick * 1.5
      ctx.beginPath()
      ctx.arc(screen.x, screen.y, radius * 1.6, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'chainDamage': {
      ctx.strokeStyle = CHAIN_DAMAGE_ACTIVE_COLOR
      ctx.lineWidth = 1.5
      const rotation = -Math.PI / 2 + (tick % 360) * 0.05
      starPath(ctx, screen, radius * 1.85, radius * 1.4, 9, rotation)
      ctx.stroke()
      break
    }
    default:
      break
  }
  ctx.restore()
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
  const oblique = options.obliqueView

  drawNodes(ctx, state, camera, oblique)
  // ユーザー要望: リング外は個々のノードにではなく、圏外全体に一様な赤の重ね塗りをする。
  // ノードを描いた後に重ねることで、地形の上に途切れなく赤が乗る(ノード円の下に隠れない)。
  // リング自体は地形と紐付かない抽象的な安全圏なので、oblique表示でも標高追従はさせない
  // (境界の円周上で毎点の地形標高を辿るのは過剰な複雑化になるため、意図的な簡略化)。
  drawRingDanger(ctx, state, camera)
  drawRingBoundaries(ctx, state, camera)
  if (options.showPatch && options.selectedUnitId !== null) {
    drawObservationPatch(ctx, state, camera, options.selectedUnitId, oblique)
  }
  drawAttackLines(ctx, state, camera, oblique)
  drawLaserBeams(ctx, state, camera)
  drawProjectiles(ctx, state, camera)
  drawUnits(ctx, state, camera, options.selectedUnitId, oblique)
  if (options.selectedUnitId !== null) {
    drawUnitOverlays(ctx, state, camera, options, oblique)
  }
  // ユーザー要望: tick・リング段階をマップの端にオーバーレイ表示する。最前面に乗せるため最後に描く。
  drawStatusOverlay(ctx, state)
}

const STATUS_OVERLAY_PADDING = 8
const STATUS_OVERLAY_LINE_HEIGHT = 18
const STATUS_OVERLAY_MARGIN = 10
const STATUS_TEXT_COLOR = '#6fe8ff'
/** ユーザー要望: 残り1チームになってからの終了カウントダウンを警告色(オレンジ)で目立たせる。 */
const STATUS_COUNTDOWN_COLOR = '#ff9800'

interface StatusSegment {
  text: string
  color: string
}

function drawStatusOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  const ring = state.ring
  const countdown = lastTeamCountdownRemaining(state)

  const tickLine: StatusSegment[] = [{ text: `Tick ${state.tick}`, color: STATUS_TEXT_COLOR }]
  if (countdown !== null) {
    tickLine.push({ text: `  残り${countdown}tick`, color: STATUS_COUNTDOWN_COLOR })
  }

  const lines: StatusSegment[][] = [
    tickLine,
    [
      {
        text: `Round ${ring.stage} (${ring.phase}, ${ring.phaseTicks}t) r=${ring.activeRadius.toFixed(1)}`,
        color: STATUS_TEXT_COLOR,
      },
    ],
  ]

  ctx.save()
  ctx.font = '13px monospace'
  ctx.textBaseline = 'top'

  const lineWidth = (line: StatusSegment[]) => line.reduce((sum, seg) => sum + ctx.measureText(seg.text).width, 0)
  const textWidth = Math.max(...lines.map(lineWidth))
  const boxWidth = textWidth + STATUS_OVERLAY_PADDING * 2
  const boxHeight = lines.length * STATUS_OVERLAY_LINE_HEIGHT + STATUS_OVERLAY_PADDING * 2 - 4
  const x = STATUS_OVERLAY_MARGIN
  const y = STATUS_OVERLAY_MARGIN

  ctx.fillStyle = 'rgba(10, 15, 30, 0.75)'
  ctx.fillRect(x, y, boxWidth, boxHeight)
  ctx.strokeStyle = 'rgba(45, 226, 255, 0.4)'
  ctx.lineWidth = 1
  ctx.strokeRect(x, y, boxWidth, boxHeight)

  lines.forEach((line, i) => {
    let segX = x + STATUS_OVERLAY_PADDING
    const lineY = y + STATUS_OVERLAY_PADDING + i * STATUS_OVERLAY_LINE_HEIGHT
    for (const seg of line) {
      ctx.fillStyle = seg.color
      ctx.fillText(seg.text, segX, lineY)
      segX += ctx.measureText(seg.text).width
    }
  })
  ctx.restore()
}

function drawNodeFace(ctx: CanvasRenderingContext2D, node: NodeState, screen: Vec2, circumradius: number): void {
  hexPath(ctx, screen, circumradius)
  ctx.fillStyle = node.passable ? elevationColor(node.elevation) : WALL_COLOR
  ctx.fill()
  if (node.passable && node.owner !== null) {
    ctx.fillStyle = teamColor(node.owner, 0.35)
    ctx.fill()
  }
}

// ノードの地図配列は1エピソード中不変(標高・座標は固定、owner/captureProgressのみ可変)なので、
// obliqueViewの描画順(ペインターズアルゴリズム: 奥=world.y昇順→手前の順)は配列の参照が変わらない
// 限り作り直す必要がない。マップ半径が大きいと数千ノードのソートになるため、毎フレーム再ソートを
// 避けるためのキャッシュ。
let obliqueOrderCache: { nodes: readonly NodeState[]; order: NodeState[] } | null = null

function obliqueDrawOrder(nodes: readonly NodeState[]): NodeState[] {
  if (obliqueOrderCache?.nodes === nodes) return obliqueOrderCache.order
  const order = [...nodes].sort((a, b) => world(a).y - world(b).y)
  obliqueOrderCache = { nodes, order }
  return order
}

function drawNodes(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera, oblique: boolean): void {
  const circumradius = Math.max(1, camera.scale * HEX_CIRCUMRADIUS_FRACTION)

  if (!oblique) {
    for (const node of state.nodes) {
      drawNodeFace(ctx, node, worldToScreen(camera, world(node)), circumradius)
    }
    return
  }

  // ユーザー要望: 標高差を可視化する斜め見下ろし表示。奥(画面上で上)のノードから先に描き、
  // 手前(下)のノードが持ち上がった地形と正しく重なるようにする(ペインターズアルゴリズム)。
  // 持ち上げ有りのノードだけ、頂面の下に地表(base位置)の暗い側面色を先に敷いて「崖」を表現する
  // (立体的な陰影までは付けない、単純な塗り分けのみ)。
  for (const node of obliqueDrawOrder(state.nodes)) {
    const base = worldToScreen(camera, world(node))
    const elevation = obliqueElevation(node)
    const top = { x: base.x, y: base.y + obliqueYOffset(camera, elevation) }

    if (elevation > 0) {
      hexPath(ctx, base, circumradius)
      ctx.fillStyle = elevationSkirtColor(node.elevation)
      ctx.fill()
    }
    drawNodeFace(ctx, node, top, circumradius)
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

  // ユーザー要望: 収縮完了時の予報円は収縮中(shrink)も表示し続ける(以前はwarnフェーズのみだった)。
  if (ring.phase === 'warn' || ring.phase === 'shrink') {
    const nextCenter = worldToScreen(camera, world(state.nodes[ring.nextCenter]))
    ctx.strokeStyle = RING_NEXT_BOUNDARY_COLOR
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.arc(nextCenter.x, nextCenter.y, Math.max(0, ring.nextRadius * camera.scale), 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

/** ユーザー要望: 飛行中のペイントボール弾を、発射元→着弾先ノードを直線補間した位置に描く
 * (§`abilities.ts`の`traveled`/`distance`)。視認性を上げるため、進行方向に短い曳光(コメット
 * テール)と発光(shadowBlur)を付ける。elevationによる立体表示は付けない簡略化。 */
function drawProjectiles(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera): void {
  const radius = Math.max(3, camera.scale * 0.16)
  for (const projectile of state.projectiles) {
    const from = worldToScreen(camera, world(state.nodes[projectile.originNode]))
    const to = worldToScreen(camera, world(state.nodes[projectile.targetNode]))
    const t = Math.max(0, Math.min(1, projectile.traveled / projectile.distance))
    const x = from.x + (to.x - from.x) * t
    const y = from.y + (to.y - from.y) * t
    const color = teamColor(projectile.teamId)

    const tailT = Math.max(0, t - 0.15)
    const tailX = from.x + (to.x - from.x) * tailT
    const tailY = from.y + (to.y - from.y) * tailT
    ctx.save()
    ctx.globalAlpha = 0.55
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1.5, radius * 0.6)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(tailX, tailY)
    ctx.lineTo(x, y)
    ctx.stroke()
    ctx.restore()

    ctx.save()
    ctx.shadowColor = color
    ctx.shadowBlur = radius * 1.5
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = PROJECTILE_STROKE_COLOR
    ctx.stroke()
    ctx.restore()
  }
}

/** ユーザー要望: レーザーは即時着弾でゲーム状態には残らないため、`state.laserBeams`(表示専用、
 * §types.ts)を発射元→到達先ノード間の光線として数tickだけ描く。`ticksRemaining`に比例して
 * フェードアウトさせる。 */
function drawLaserBeams(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera): void {
  for (const beam of state.laserBeams) {
    const from = worldToScreen(camera, world(state.nodes[beam.originNode]))
    const to = worldToScreen(camera, world(state.nodes[beam.endNode]))
    const alpha = Math.max(0, Math.min(1, beam.ticksRemaining / LASER_BEAM_DISPLAY_TICKS))
    const color = teamColor(beam.teamId)

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.shadowColor = color
    ctx.shadowBlur = 10
    ctx.lineCap = 'round'

    ctx.strokeStyle = color
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()

    ctx.strokeStyle = LASER_BEAM_COLOR
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    ctx.restore()
  }
}

function drawAttackLines(ctx: CanvasRenderingContext2D, state: GameState, camera: Camera, oblique: boolean): void {
  ctx.save()
  ctx.strokeStyle = ATTACK_LINE_COLOR
  ctx.lineWidth = 1.5
  for (const unit of state.units) {
    if (!unit.alive || unit.attackTarget === null) continue
    const target = state.units.find((u) => u.id === unit.attackTarget)
    if (!target || !target.alive) continue
    const from = unitScreen(camera, state, unit, oblique)
    const to = unitScreen(camera, state, target, oblique)
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
  oblique: boolean,
): void {
  const radius = Math.max(2, camera.scale * UNIT_RADIUS_FRACTION)
  for (const unit of state.units) {
    if (!unit.alive) continue
    const screen = unitScreen(camera, state, unit, oblique)

    unitShapePath(ctx, unit.ability, screen, radius)
    ctx.fillStyle = teamColor(unit.teamId)
    ctx.fill()

    if (unit.id === selectedUnitId) {
      ctx.lineWidth = 2
      ctx.strokeStyle = '#ffffff'
      ctx.stroke()
    }

    // ユーザー要望: バフ系アビリティ(damageShield/speedBoost/chainDamage)発動中は種類ごとに
    // 完全に異なる見た目で分かるようにする(§drawAbilityBuffIndicator)。
    if (unit.abilityActiveTicksRemaining > 0) {
      drawAbilityBuffIndicator(ctx, unit.ability, screen, radius, state.tick)
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

/** ユーザー要望: 視野が円ではなく「コア+6方向の棘」の星形になったため、円ストロークではなく
 * `drawObservationPatch`と同じ「該当ヘックスを塗る」方式で表現する(§`hexgrid.ts`の
 * `visionStarOffsets`)。 */
function drawVisionOverlay(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: Camera,
  unit: UnitState,
  oblique: boolean,
): void {
  const nodeIndex = new Map<string, number>()
  state.nodes.forEach((n, i) => nodeIndex.set(axialKey(n), i))

  const selfNode = state.nodes[unit.pos.to]
  const circumradius = Math.max(1, camera.scale * HEX_CIRCUMRADIUS_FRACTION)

  ctx.save()
  ctx.fillStyle = VISION_RANGE_COLOR
  for (const offset of visionStarOffsets(state.config.visionCoreRadius, state.config.visionSpikeRange)) {
    const idx = nodeIndex.get(axialKey({ q: selfNode.q + offset.q, r: selfNode.r + offset.r }))
    if (idx === undefined) continue
    const screen = nodeScreen(camera, state.nodes[idx], oblique)
    hexPath(ctx, screen, circumradius)
    ctx.fill()
  }
  ctx.restore()
}

function drawUnitOverlays(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: Camera,
  options: DrawOptions,
  oblique: boolean,
): void {
  const unit = state.units.find((u) => u.id === options.selectedUnitId)
  if (!unit || !unit.alive) return
  const screen = unitScreen(camera, state, unit, oblique)

  if (options.showVision) drawVisionOverlay(ctx, state, camera, unit, oblique)

  if (options.showAttackRange) {
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = ATTACK_RANGE_COLOR
    ctx.beginPath()
    ctx.arc(screen.x, screen.y, state.config.attackRange * camera.scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}

/** §11.2の観測パッチと同じ形状(半径patchHopsホップの六角パッチ)を選択ユニット中心にハイライトする。 */
function drawObservationPatch(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: Camera,
  selectedUnitId: number,
  oblique: boolean,
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
    const screen = nodeScreen(camera, state.nodes[idx], oblique)
    hexPath(ctx, screen, circumradius)
    ctx.fill()
  }
  ctx.restore()
}
