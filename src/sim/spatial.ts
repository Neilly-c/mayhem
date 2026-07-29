import type { GameState, UnitState, Vec2 } from './types'
import { world } from './hexgrid'

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Continuous world position, linearly interpolated across the edge for mid-edge units. */
export function unitWorldPos(state: GameState, unit: UnitState): Vec2 {
  const from = world(state.nodes[unit.pos.from])
  if (unit.pos.from === unit.pos.to) return from
  const to = world(state.nodes[unit.pos.to])
  return { x: lerp(from.x, to.x, unit.pos.progress), y: lerp(from.y, to.y, unit.pos.progress) }
}

/**
 * True facing direction (unnormalized world-space vector along the current edge), or null while
 * stationary — a stationary unit has no inherent facing (combat treats it as omnidirectional;
 * callers that want a display-only facing for a stationary unit, e.g. facing its attack target,
 * need their own fallback since that's not a real facing).
 */
export function unitFacingVector(state: GameState, unit: UnitState): Vec2 | null {
  if (unit.pos.from === unit.pos.to) return null
  const fromWorld = world(state.nodes[unit.pos.from])
  const toWorld = world(state.nodes[unit.pos.to])
  return { x: toWorld.x - fromWorld.x, y: toWorld.y - fromWorld.y }
}

/** Elevation at the unit's current position, interpolated across the edge endpoints (§7.2). */
export function unitElevation(state: GameState, unit: UnitState): number {
  const fromElevation = state.nodes[unit.pos.from].elevation
  if (unit.pos.from === unit.pos.to) return fromElevation
  const toElevation = state.nodes[unit.pos.to].elevation
  return lerp(fromElevation, toElevation, unit.pos.progress)
}

export function worldDistBetween(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
