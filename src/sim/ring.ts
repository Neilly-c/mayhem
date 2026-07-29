import type { GameState, NodeState, RingState, SimConfig, Vec2 } from './types'
import { world } from './hexgrid'
import { unitWorldPos, worldDistBetween } from './spatial'
import { deriveRng, randInt } from './rng'

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }
}

/**
 * A new center is always drawn from currently-safe *passable* nodes, so it can never land on a
 * wall or an unreachable spot (§10's "snap to nearest passable" correction is unnecessary because
 * walls are excluded from the candidate set up front, not fixed up after the fact).
 *
 * `maxDrift` bounds how far the new center may sit from `centerWorld` — callers MUST pass
 * `oldRadius - newRadius` here (not the old radius alone). See `pickNextCenter` for why.
 */
function pickRandomNodeWithinRadius(
  seed: number,
  purpose: string,
  nodes: NodeState[],
  centerWorld: Vec2,
  maxDrift: number,
): number {
  const candidates: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].passable) continue
    if (worldDistBetween(world(nodes[i]), centerWorld) <= maxDrift) candidates.push(i)
  }
  if (candidates.length === 0) {
    // Defensive fallback (should only matter for a walled map origin at stage 0 — see
    // initRingState): fall back to the nearest passable node anywhere, unconstrained.
    let nearest = -1
    let nearestDist = Infinity
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].passable) continue
      const dist = worldDistBetween(world(nodes[i]), centerWorld)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = i
      }
    }
    return nearest
  }
  const rng = deriveRng(seed, purpose)
  return candidates[randInt(rng, candidates.length)]
}

/**
 * ユーザー要望: 一度リング外(危険地帯)になった領域は、以降のリングで再びリング内に戻らない。
 * 新しい中心を「現在の中心からoldRadius-newRadius以内」に制限することで、収縮アニメーション中
 * 常に新しい安全円が旧安全円に完全に内包されることを保証する(端点だけでなく補間の全過程で)。
 * 証明: center(t)=lerp(O,C,t), radius(t)=lerp(oldR,newR,t) のとき
 *   dist(O,center(t)) + radius(t) = t·d + oldR - t·(oldR-newR) = oldR - t·((oldR-newR)-d)
 * であり、d(=dist(O,C)) <= oldR-newR を満たす限り、上式は常に oldR 以下になる(t∈[0,1])。
 */
function pickNextCenter(
  seed: number,
  purpose: string,
  nodes: NodeState[],
  oldCenterWorld: Vec2,
  oldRadius: number,
  newRadius: number,
): number {
  const maxDrift = Math.max(0, oldRadius - newRadius)
  return pickRandomNodeWithinRadius(seed, purpose, nodes, oldCenterWorld, maxDrift)
}

/** §8: stage 0 starts safe across the whole generated map, centered on the generation origin. */
export function initRingState(seed: number, config: SimConfig, nodes: NodeState[]): RingState {
  const originIdx = nodes.findIndex((n) => n.q === 0 && n.r === 0)
  if (originIdx === -1) throw new Error('Map has no origin node (q=0, r=0)')

  const originWorld = world(nodes[originIdx])
  const stage0Radius = config.ringRadiusSchedule[0]
  const nextCenter = pickNextCenter(seed, 'ring:0', nodes, originWorld, stage0Radius, config.ringRadiusSchedule[1])

  return {
    stage: 0,
    phase: 'warn',
    phaseTicks: 0,
    centerWorld: originWorld,
    activeRadius: stage0Radius,
    shrinkStartCenter: originWorld,
    nextCenter,
    nextRadius: config.ringRadiusSchedule[1],
  }
}

/**
 * §8 段階遷移 + ユーザー要望: warn(既定120t、中心・半径は前段階のまま固定)→shrink(既定180t)。
 * shrink中は「前回のリングの中心から新しいリングの中心へ」半径の収縮と歩調を合わせて
 * 等速直線運動で中心も移動する(centerとradius, どちらも同じtで線形補間)。最終段は'done'。
 */
export function tickRing(state: GameState): void {
  const ring = state.ring
  if (ring.phase === 'done') return

  const schedule = state.config.ringRadiusSchedule
  ring.phaseTicks++

  if (ring.phase === 'warn') {
    if (ring.phaseTicks >= state.config.warnTicks) {
      ring.phase = 'shrink'
      ring.phaseTicks = 0
      ring.shrinkStartCenter = ring.centerWorld // interpolation start snapshot
    }
    return
  }

  const t = Math.min(1, ring.phaseTicks / state.config.shrinkTicks)
  const targetCenterWorld = world(state.nodes[ring.nextCenter])
  ring.centerWorld = lerpVec2(ring.shrinkStartCenter, targetCenterWorld, t)
  ring.activeRadius = lerp(schedule[ring.stage], schedule[ring.stage + 1], t)

  if (ring.phaseTicks >= state.config.shrinkTicks) {
    ring.centerWorld = targetCenterWorld // exact final value, avoid float drift
    ring.activeRadius = schedule[ring.stage + 1]
    ring.stage++
    ring.phaseTicks = 0

    if (ring.stage >= schedule.length - 1) {
      ring.phase = 'done'
    } else {
      ring.phase = 'warn'
      ring.nextRadius = schedule[ring.stage + 1]
      ring.nextCenter = pickNextCenter(
        state.seed,
        `ring:${ring.stage}`,
        state.nodes,
        ring.centerWorld,
        ring.activeRadius,
        ring.nextRadius,
      )
    }
  }
}

/**
 * ユーザー要望: スリップダメージは段階の境目で階段状に増えるのではなく、ラウンドの進行とともに
 * 連続的に大きくなるようにする。`slipDamage[stage]`を起点に、現段階の経過(warn+shrinkの合計に
 * 対する経過tick比率)に応じて`slipDamage[stage+1]`へ向けて線形に補間する。'done'後は最終値を使う。
 */
function computeSlipDamage(state: GameState): number {
  const ring = state.ring
  const slipTable = state.config.slipDamage
  const fromDamage = slipTable[Math.min(ring.stage, slipTable.length - 1)]
  if (ring.phase === 'done') return fromDamage

  const toDamage = slipTable[Math.min(ring.stage + 1, slipTable.length - 1)]
  const totalStageTicks = state.config.warnTicks + state.config.shrinkTicks
  const ticksIntoStage = ring.phase === 'warn' ? ring.phaseTicks : state.config.warnTicks + ring.phaseTicks
  const t = totalStageTicks > 0 ? Math.min(1, ticksIntoStage / totalStageTicks) : 0
  return lerp(fromDamage, toDamage, t)
}

/** §8 圏外スリップダメージ。 */
export function applySlipDamage(state: GameState): { unitId: number; damage: number }[] {
  const slip = computeSlipDamage(state)
  if (slip <= 0) return []

  const ring = state.ring
  const events: { unitId: number; damage: number }[] = []
  for (const unit of state.units) {
    if (!unit.alive) continue
    if (worldDistBetween(unitWorldPos(state, unit), ring.centerWorld) > ring.activeRadius) {
      unit.hp -= slip
      events.push({ unitId: unit.id, damage: slip })
    }
  }
  return events
}
