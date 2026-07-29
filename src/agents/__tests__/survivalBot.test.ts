import { describe, expect, it } from 'vitest'
import { createConfig, generateMap, initRingState } from '../../sim'
import type { GameState, SimConfig, UnitState } from '../../sim'
import { decideCommands, defaultSurvivalBotConfig } from '../survivalBot'

function makeUnit(id: number, teamId: number, atNode: number, hp = 100, alive = true): UnitState {
  return {
    id,
    teamId,
    pos: { from: atNode, to: atNode, progress: 0 },
    hp,
    alive,
    command: { type: 'idle' },
    attackTarget: null,
    destination: null,
    path: null,
    lastDamagedByTeamId: null,
  }
}

/** wallThreshold:0 -> every generated node passable, giving a real hex disk with true 6-neighbor geometry. */
function makeState(seed: number, overrides?: Partial<SimConfig>): GameState {
  const config = createConfig({
    mapRadius: 4,
    wallThreshold: 0,
    visionRange: 100,
    attackRange: 2,
    ...overrides,
  })
  const { nodes, neighbors } = generateMap(seed, config)
  const state: GameState = {
    seed,
    tick: 0,
    config,
    nodes,
    neighbors,
    teams: [
      { id: 0, alive: true, eliminatedAtTick: null, killCount: 0 },
      { id: 1, alive: true, eliminatedAtTick: null, killCount: 0 },
    ],
    units: [],
    ring: initRingState(seed, config, nodes),
  }
  state.ring.activeRadius = 100 // large enough that ring never interferes unless a test overrides it
  return state
}

function nodeAt(state: GameState, q: number, r: number): number {
  const idx = state.nodes.findIndex((n) => n.q === q && n.r === r)
  if (idx === -1) throw new Error(`no node at (${q},${r})`)
  return idx
}

describe('survivalBot', () => {
  it('moves toward the ring center when currently outside the safe zone, regardless of HP', () => {
    const state = makeState(1)
    const selfNode = nodeAt(state, 2, 0)
    state.units = [makeUnit(0, 0, selfNode, 5)] // low HP too, but ring escape wins
    state.ring.centerWorld = { x: 0, y: 0 }
    state.ring.activeRadius = 1.0 // self at world (2,0), distance 2 -> outside

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveDirection', dir: 3 }) // toward (0,0)
  })

  it('heads to the nearest own-owned node to heal when HP is below the threshold', () => {
    const state = makeState(2)
    const selfNode = nodeAt(state, 0, 0)
    const ownNode = nodeAt(state, 2, 0)
    state.nodes[ownNode].owner = 0
    state.units = [makeUnit(0, 0, selfNode, 10)] // hp fraction 0.1 < default healHpFraction 0.5

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: ownNode })
  })

  it('goes idle once standing on own territory while healing', () => {
    const state = makeState(3)
    const ownNode = nodeAt(state, 0, 0)
    state.nodes[ownNode].owner = 0
    state.units = [makeUnit(0, 0, ownNode, 10)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'idle' })
  })

  it('falls back to heading toward the stronghold when low HP and no own territory exists yet', () => {
    const state = makeState(4)
    for (const node of state.nodes) node.elevation = 0 // flat terrain so distance-to-anchor decides
    const selfNode = nodeAt(state, 0, 0)
    state.ring.nextCenter = selfNode // stronghold search anchored here, self already standing on it
    state.units = [makeUnit(0, 0, selfNode, 10)]

    const decisions = decideCommands(state, [0])
    // Already at the (only-candidate) stronghold and no own territory -> nothing left to path to.
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: selfNode })
  })

  it('moves toward a higher-elevation node near the disclosed next ring center over the center itself', () => {
    const state = makeState(5)
    const center = nodeAt(state, 0, 0)
    const highGround = nodeAt(state, 1, 0)
    for (const node of state.nodes) node.elevation = 0
    state.nodes[highGround].elevation = 1 // dist 1 vs elevationWeight 6 -> score 5, beats center's score 0
    state.ring.nextCenter = center

    const selfNode = nodeAt(state, -3, 0)
    state.units = [makeUnit(0, 0, selfNode, 100)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: highGround })
  })

  it('skips the best-scoring point when another team already owns it, picking the next-best safe point', () => {
    const state = makeState(12)
    const center = nodeAt(state, 0, 0)
    const secondBest = nodeAt(state, 1, 0)
    for (const node of state.nodes) node.elevation = 0
    state.nodes[center].elevation = 2 // best score if safe: 2*6 - 0 = 12
    state.nodes[center].owner = 1 // ...but already taken by team 1
    state.nodes[secondBest].elevation = 1 // next-best safe score: 1*6 - 1 = 5
    state.ring.nextCenter = center

    const selfNode = nodeAt(state, -3, 0)
    state.units = [makeUnit(0, 0, selfNode, 100)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: secondBest })
  })

  it('skips a point actively defended by an enemy unit within attack range, even if unowned', () => {
    const state = makeState(13, { attackRange: 0.5 }) // small range so only the contested point itself is threatened
    const center = nodeAt(state, 0, 0)
    const secondBest = nodeAt(state, 1, 0)
    for (const node of state.nodes) node.elevation = 0
    state.nodes[center].elevation = 2
    state.nodes[secondBest].elevation = 1
    state.ring.nextCenter = center

    const selfNode = nodeAt(state, -3, 0)
    const enemyNode = center // enemy sitting right on the best point, well within attack range (dist 0)
    state.units = [makeUnit(0, 0, selfNode, 100), makeUnit(1, 1, enemyNode)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: secondBest })
  })

  it('falls back to the best-scoring point when every candidate nearby is already taken', () => {
    const state = makeState(14, { attackRange: 0 }) // avoid unit-presence threat from own placeholder unit far away
    const center = nodeAt(state, 0, 0)
    for (const node of state.nodes) node.elevation = 0
    state.nodes[center].elevation = 2
    state.nodes[center].owner = 1
    for (const n of state.neighbors[center]) state.nodes[n].owner = 1 // every 1-hop neighbor also enemy-owned
    state.ring.nextCenter = center

    const selfNode = nodeAt(state, -3, 0)
    state.units = [makeUnit(0, 0, selfNode, 100, true), makeUnit(1, 1, nodeAt(state, 4, 0))]
    const strongholdOnlyConfig = { ...defaultSurvivalBotConfig(), holdHops: 1 }

    const decisions = decideCommands(state, [0], strongholdOnlyConfig)
    // Nothing within holdHops:1 is safe -> falls back to the highest-scoring point regardless (the center).
    expect(decisions.get(0)?.command).toEqual({ type: 'moveTo', node: center })
  })

  it('claims a nearby unclaimed node once it has arrived at the stronghold', () => {
    const state = makeState(6)
    const stronghold = nodeAt(state, 0, 0)
    for (const node of state.nodes) node.elevation = 0
    state.ring.nextCenter = stronghold
    state.units = [makeUnit(0, 0, stronghold, 100)]

    const decisions = decideCommands(state, [0])
    const command = decisions.get(0)?.command
    expect(command?.type).toBe('moveTo')
    const targetNode = command && command.type === 'moveTo' ? command.node : -1
    expect(state.nodes[targetNode].owner).toBeNull()
  })

  it('goes idle once the stronghold and its whole vicinity are already own territory', () => {
    const state = makeState(7)
    const stronghold = nodeAt(state, 0, 0)
    for (const node of state.nodes) {
      node.elevation = 0
      node.owner = 0
    }
    state.ring.nextCenter = stronghold
    state.units = [makeUnit(0, 0, stronghold, 100)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.command).toEqual({ type: 'idle' })
  })

  it('counter-attacks the nearest in-range enemy independently of the movement decision', () => {
    const state = makeState(8)
    const selfNode = nodeAt(state, 0, 0)
    const enemyNode = nodeAt(state, 1, 0) // world distance 1.0, within attackRange 2.0
    state.ring.nextCenter = nodeAt(state, -3, 0) // far away, so movement heads elsewhere
    state.units = [makeUnit(0, 0, selfNode, 100), makeUnit(1, 1, enemyNode)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.attackTarget).toBe(1)
  })

  it('does not chase a visible enemy that is out of attack range', () => {
    const state = makeState(9, { attackRange: 0.5 })
    const selfNode = nodeAt(state, 0, 0)
    const enemyNode = nodeAt(state, 1, 0) // distance 1.0 > attackRange 0.5
    state.ring.nextCenter = selfNode
    state.units = [makeUnit(0, 0, selfNode, 100), makeUnit(1, 1, enemyNode)]

    const decisions = decideCommands(state, [0])
    expect(decisions.get(0)?.attackTarget).toBeNull()
  })

  it('skips dead and unknown units', () => {
    const state = makeState(10)
    const selfNode = nodeAt(state, 0, 0)
    state.units = [makeUnit(0, 0, selfNode, 100, false)]

    const decisions = decideCommands(state, [0, 999])
    expect(decisions.size).toBe(0)
  })

  it('respects config overrides for the heal threshold', () => {
    const state = makeState(11)
    const ownNode = nodeAt(state, 0, 0)
    state.nodes[ownNode].owner = 0
    state.units = [makeUnit(0, 0, ownNode, 60)] // hp fraction 0.6

    const strictConfig = { ...defaultSurvivalBotConfig(), healHpFraction: 0.7 }
    const decisions = decideCommands(state, [0], strictConfig)
    // 0.6 < 0.7 -> heal branch, already on own node -> idle (would not be idle for this reason at default 0.5)
    expect(decisions.get(0)?.command).toEqual({ type: 'idle' })
  })
})
