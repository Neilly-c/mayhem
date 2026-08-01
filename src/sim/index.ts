export * from './types'
export { defaultConfig, createConfig } from './config'
export { mulberry32, deriveRng, randInt } from './rng'
export type { RngFn } from './rng'
export { PerlinNoise2D } from './noise'
export {
  DIRECTIONS,
  axialToCube,
  hexDist,
  world,
  worldDist,
  axialAdd,
  axialKey,
  nodesInRadius,
  withinVisionStar,
  visionStarOffsets,
} from './hexgrid'
export type { CubeCoord } from './hexgrid'
export { generateMap } from './mapgen'
export type { MapData } from './mapgen'
export { findPath } from './pathfinding'
export { createTeamsAndUnits } from './entities'
export { computeMovementIntent, applyMovementIntent } from './movement'
export type { MovementIntent } from './movement'
export { unitWorldPos, unitElevation, unitFacingVector, worldDistBetween } from './spatial'
export { computeCombatIntents, applyCombatIntent, damageShieldCoefFor } from './combat'
export type { CombatIntent } from './combat'
export { resolveAbilities, LASER_BEAM_DISPLAY_TICKS, isDirectionalAbility, maxCooldownFor, maxDurationFor } from './abilities'
export type { AbilityResolution } from './abilities'
export { resolveTerritory } from './territory'
export { initRingState, tickRing, applySlipDamage } from './ring'
export { applyRegen } from './regen'
export {
  isGameOver,
  getWinnerTeamId,
  getRanking,
  teamTerritoryRate,
  getTerritoryRanking,
  lastTeamCountdownRemaining,
} from './rules'
export { Simulation } from './sim'
