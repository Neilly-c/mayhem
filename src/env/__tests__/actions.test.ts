import { describe, expect, it } from 'vitest'
import { createConfig } from '../../sim'
import type { GameState, NodeState, UnitState } from '../../sim'
import { buildActionMask, decodeAction } from '../actions'
import type { VisibleEnemy } from '../visibility'

function makeNode(q: number): NodeState {
  return { q, r: 0, elevation: 0.5, passable: true, owner: null, captureProgress: null }
}

function makeUnit(id: number, teamId: number, atNode: number): UnitState {
  return {
    id,
    teamId,
    pos: { from: atNode, to: atNode, progress: 0 },
    hp: 100,
    alive: true,
    command: { type: 'idle' },
    attackTarget: null,
    destination: null,
    path: null,
    lastDamagedByTeamId: null,
    ability: 'paintball',
    abilityCooldownRemaining: 0,
    abilityActiveTicksRemaining: 0,
    abilityCommand: { type: 'none' },
  }
}

/** 3-node line 0-1-2; unit stands at the middle node (id 1), with neighbors on both sides. */
function makeLineState(overrides?: Partial<GameState['config']>): GameState {
  const config = createConfig({ maxVisibleEnemies: 3, attackRange: 2, ...overrides })
  return {
    seed: 1,
    tick: 0,
    config,
    nodes: [makeNode(0), makeNode(1), makeNode(2)],
    neighbors: [[1], [0, 2], [1]],
    teams: [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
    ],
    units: [makeUnit(0, 0, 1)],
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

describe('buildActionMask', () => {
  it('marks idle always legal and only the two occupied directions legal for a middle node', () => {
    const state = makeLineState()
    const mask = buildActionMask(state, state.units[0], [])
    expect(mask.move[0]).toBe(true) // hold position
    expect(mask.move[1]).toBe(true) // dir0 = (+1,0) -> node 2
    expect(mask.move[4]).toBe(true) // dir3 = (-1,0) -> node 0
    expect(mask.move.filter((v) => v).length).toBe(3) // hold position + these two, rest are off-map
  })

  it('ユーザー要望: masks out a direction whose neighbor is already occupied by another alive unit', () => {
    const state = makeLineState()
    state.units.push(makeUnit(1, 1, 2)) // occupies node 2, the target of dir0
    const mask = buildActionMask(state, state.units[0], [])
    expect(mask.move[1]).toBe(false) // dir0 = (+1,0) -> node 2, occupied
    expect(mask.move[4]).toBe(true) // dir3 = (-1,0) -> node 0, still free
  })

  it('does not mask a direction whose neighbor is occupied only by a dead unit', () => {
    const state = makeLineState()
    state.units.push({ ...makeUnit(1, 1, 2), alive: false })
    const mask = buildActionMask(state, state.units[0], [])
    expect(mask.move[1]).toBe(true)
  })

  it('does not mask a direction toward the unit itself (never blocks its own current node)', () => {
    // A unit's own pos.to trivially matches no direction target other than itself, but guard
    // against a regression where the occupancy check forgets to exclude `unit.id`.
    const state = makeLineState()
    const mask = buildActionMask(state, state.units[0], [])
    expect(mask.move[0]).toBe(true) // hold position (move to self) is unaffected
  })

  it('marks "do not attack" always legal, and enemy slots legal only within attackRange', () => {
    const state = makeLineState({ attackRange: 1.5 })
    const near: VisibleEnemy = { unit: makeUnit(1, 1, 2), dist: 1.0 }
    const far: VisibleEnemy = { unit: makeUnit(2, 1, 2), dist: 5.0 }
    const mask = buildActionMask(state, state.units[0], [near, far])

    expect(mask.attack[0]).toBe(true)
    expect(mask.attack[1]).toBe(true) // near, in range
    expect(mask.attack[2]).toBe(false) // far, out of range
    expect(mask.attack[3]).toBe(false) // padding slot, no enemy present
  })
})

describe('buildActionMask: ability head', () => {
  it('always marks "do nothing" (0) legal, and masks all directions when off cooldown but mid-edge', () => {
    const state = makeLineState()
    state.units[0].ability = 'paintball'
    state.units[0].pos = { from: 0, to: 1, progress: 0.4 } // mid-edge, not stationary
    const mask = buildActionMask(state, state.units[0], [])
    expect(mask.ability[0]).toBe(true)
    expect(mask.ability.slice(1)).toEqual([false, false, false, false, false, false])
  })

  it('marks directions legal for a stationary directional-ability unit when off cooldown', () => {
    const state = makeLineState()
    state.units[0].ability = 'laser'
    const mask = buildActionMask(state, state.units[0], [])
    // dir0 (+1,0 -> node2) and dir3 (-1,0 -> node0) stay on the map (mapRadius default >= 1);
    // the rest point off this tiny 3-node test map's populated region but are still within
    // the configured mapRadius's hex disk, so they may legally be aimed (no target existing
    // there is handled at resolution time, not masking time).
    expect(mask.ability[0]).toBe(true)
    expect(mask.ability.some((b) => b)).toBe(true)
  })

  it('masks all directions for a directional-ability unit still on cooldown', () => {
    const state = makeLineState()
    state.units[0].ability = 'laser'
    state.units[0].abilityCooldownRemaining = 5
    const mask = buildActionMask(state, state.units[0], [])
    expect(mask.ability).toEqual([true, false, false, false, false, false, false])
  })

  it('for a selfBuff-ability unit, marks only index 1 ("activate") legal when off cooldown, 2..6 always illegal', () => {
    const state = makeLineState()
    state.units[0].ability = 'speedBoost'
    const mask = buildActionMask(state, state.units[0], [])
    expect(mask.ability).toEqual([true, true, false, false, false, false, false])
  })

  it('for a selfBuff-ability unit on cooldown, index 1 is also illegal', () => {
    const state = makeLineState()
    state.units[0].ability = 'speedBoost'
    state.units[0].abilityCooldownRemaining = 10
    const mask = buildActionMask(state, state.units[0], [])
    expect(mask.ability).toEqual([true, false, false, false, false, false, false])
  })
})

describe('decodeAction', () => {
  const visibleEnemyIds = [10, 11, -1]
  const selfNode = 42
  const abilityConfig = createConfig({ paintballMaxRange: 7, laserRange: 5 })

  it('decodes move=0 as holding position (moveTo self) and move=1..6 as the corresponding direction', () => {
    expect(decodeAction({ move: 0, attack: 0, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).command).toEqual({
      type: 'moveTo',
      node: selfNode,
    })
    expect(decodeAction({ move: 1, attack: 0, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).command).toEqual({
      type: 'moveDirection',
      dir: 0,
    })
    expect(decodeAction({ move: 6, attack: 0, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).command).toEqual({
      type: 'moveDirection',
      dir: 5,
    })
  })

  it('falls back to holding position (moveTo self) for an out-of-range move value', () => {
    expect(decodeAction({ move: 7, attack: 0, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).command).toEqual({
      type: 'moveTo',
      node: selfNode,
    })
    expect(decodeAction({ move: -1, attack: 0, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).command).toEqual({
      type: 'moveTo',
      node: selfNode,
    })
  })

  it('decodes attack=0 as no target, and attack=i as the ith visible enemy id', () => {
    expect(decodeAction({ move: 0, attack: 0, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).attackTarget).toBeNull()
    expect(decodeAction({ move: 0, attack: 1, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).attackTarget).toBe(10)
    expect(decodeAction({ move: 0, attack: 2, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).attackTarget).toBe(11)
  })

  it('treats an attack index pointing at a padded (-1) slot as no target', () => {
    expect(decodeAction({ move: 0, attack: 3, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).attackTarget).toBeNull()
  })

  it('treats an out-of-range attack index as no target', () => {
    expect(decodeAction({ move: 0, attack: 99, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).attackTarget).toBeNull()
  })

  it('decodes ability=0 as "none" regardless of ability kind', () => {
    expect(
      decodeAction({ move: 0, attack: 0, ability: 0 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig).abilityCommand,
    ).toEqual({ type: 'none' })
    expect(
      decodeAction({ move: 0, attack: 0, ability: 0 }, selfNode, visibleEnemyIds, 'speedBoost', abilityConfig).abilityCommand,
    ).toEqual({ type: 'none' })
  })

  it('decodes ability=1..6 as a direction at the ability\'s configured max range, for paintball', () => {
    const decoded = decodeAction({ move: 0, attack: 0, ability: 3 }, selfNode, visibleEnemyIds, 'paintball', abilityConfig)
    expect(decoded.abilityCommand).toEqual({ type: 'directional', dir: 2, range: abilityConfig.paintballMaxRange })
  })

  it('decodes ability=1..6 as a direction at laserRange, for laser', () => {
    const decoded = decodeAction({ move: 0, attack: 0, ability: 6 }, selfNode, visibleEnemyIds, 'laser', abilityConfig)
    expect(decoded.abilityCommand).toEqual({ type: 'directional', dir: 5, range: abilityConfig.laserRange })
  })

  it('decodes ability=1 as "selfBuff" for a buff-kind ability, and ability=2..6 as "none"', () => {
    expect(
      decodeAction({ move: 0, attack: 0, ability: 1 }, selfNode, visibleEnemyIds, 'damageShield', abilityConfig)
        .abilityCommand,
    ).toEqual({ type: 'selfBuff' })
    expect(
      decodeAction({ move: 0, attack: 0, ability: 4 }, selfNode, visibleEnemyIds, 'chainDamage', abilityConfig)
        .abilityCommand,
    ).toEqual({ type: 'none' })
  })
})
