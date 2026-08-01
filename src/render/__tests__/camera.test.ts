import { describe, expect, it } from 'vitest'
import { createConfig, generateMap } from '../../sim'
import type { GameState } from '../../sim'
import { fitCamera, screenToWorld, worldToScreen } from '../camera'

function makeState(mapRadius: number): GameState {
  const config = createConfig({ mapRadius })
  const { nodes, neighbors } = generateMap(1, config)
  return {
    seed: 1,
    tick: 0,
    config,
    nodes,
    neighbors,
    teams: [],
    units: [],
    ring: {
      stage: 0,
      phase: 'warn',
      phaseTicks: 0,
      centerWorld: { x: 0, y: 0 },
      activeRadius: 100,
      shrinkStartCenter: { x: 0, y: 0 },
      nextCenter: 0,
      nextRadius: 100,
    },
    projectiles: [],
    nextProjectileId: 0,
    laserBeams: [],
    nextLaserBeamId: 0,
  }
}

describe('fitCamera / worldToScreen / screenToWorld', () => {
  it('maps the map origin near the canvas center', () => {
    const state = makeState(5)
    const camera = fitCamera(state, 800, 600)
    const screen = worldToScreen(camera, { x: 0, y: 0 })
    // origin isn't necessarily the world-bbox center, but should land well within the canvas
    expect(screen.x).toBeGreaterThan(0)
    expect(screen.x).toBeLessThan(800)
    expect(screen.y).toBeGreaterThan(0)
    expect(screen.y).toBeLessThan(600)
  })

  it('keeps the whole map within the padded canvas bounds', () => {
    const state = makeState(8)
    const padding = 20
    const camera = fitCamera(state, 800, 600, padding)
    for (const node of state.nodes) {
      const screen = worldToScreen(camera, { x: node.q + node.r * 0.5, y: node.r * (Math.sqrt(3) / 2) })
      expect(screen.x).toBeGreaterThanOrEqual(padding - 1)
      expect(screen.x).toBeLessThanOrEqual(800 - padding + 1)
      expect(screen.y).toBeGreaterThanOrEqual(padding - 1)
      expect(screen.y).toBeLessThanOrEqual(600 - padding + 1)
    }
  })

  it('screenToWorld is the exact inverse of worldToScreen', () => {
    const state = makeState(5)
    const camera = fitCamera(state, 800, 600)
    const original = { x: 3.4, y: -2.1 }
    const roundTripped = screenToWorld(camera, worldToScreen(camera, original))
    expect(roundTripped.x).toBeCloseTo(original.x, 10)
    expect(roundTripped.y).toBeCloseTo(original.y, 10)
  })
})
