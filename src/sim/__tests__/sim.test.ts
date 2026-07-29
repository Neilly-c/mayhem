import { describe, expect, it } from 'vitest'
import { Simulation } from '../sim'
import { createConfig } from '../config'
import { getWinnerTeamId, isGameOver } from '../rules'
import { findPath } from '../pathfinding'
import { hexDist } from '../hexgrid'

const TEST_CONFIG = { mapRadius: 10, teamCount: 3, unitsPerTeam: 3 }

describe('Simulation', () => {
  it('creates the configured number of teams and units, all alive and on passable nodes', () => {
    const sim = Simulation.create(1, TEST_CONFIG)
    expect(sim.state.teams).toHaveLength(3)
    expect(sim.state.units).toHaveLength(9)
    for (const unit of sim.state.units) {
      expect(unit.alive).toBe(true)
      expect(unit.hp).toBe(sim.state.config.unitHP)
      expect(sim.state.nodes[unit.pos.to].passable).toBe(true)
    }
    // No two units should spawn on the same node.
    const occupied = new Set(sim.state.units.map((u) => u.pos.to))
    expect(occupied.size).toBe(sim.state.units.length)
  })

  it('ユーザー要望: never lets two alive units share a node across a long run under natural (idle-explore) movement pressure on a small, dense map', () => {
    const sim = Simulation.create(5, { mapRadius: 5, wallThreshold: 0, teamCount: 4, unitsPerTeam: 3 })
    for (let i = 0; i < 400; i++) {
      sim.step()
      const occupiedNodes = sim.state.units.filter((u) => u.alive).map((u) => u.pos.to)
      expect(new Set(occupiedNodes).size).toBe(occupiedNodes.length)
    }
  })

  it('runs headlessly for many ticks without throwing', () => {
    const sim = Simulation.create(2, TEST_CONFIG)
    expect(() => {
      for (let i = 0; i < 300; i++) sim.step()
    }).not.toThrow()
    expect(sim.state.tick).toBe(300)
  })

  it('is fully deterministic: same seed + same commands -> identical state', () => {
    const commands: { tick: number; unitId: number; node: number }[] = [
      { tick: 5, unitId: 0, node: 40 },
      { tick: 5, unitId: 3, node: 12 },
      { tick: 50, unitId: 1, node: 7 },
    ]

    function run(): ReturnType<Simulation['toJSON']> {
      const sim = Simulation.create(123, TEST_CONFIG)
      for (let t = 1; t <= 120; t++) {
        for (const c of commands) {
          if (c.tick === t) sim.setCommand(c.unitId, { type: 'moveTo', node: c.node })
        }
        sim.step()
      }
      return sim.toJSON()
    }

    const a = run()
    const b = run()
    expect(a).toEqual(b)
  })

  it('produces different runs for different seeds', () => {
    const simA = Simulation.create(1, TEST_CONFIG)
    const simB = Simulation.create(2, TEST_CONFIG)
    expect(simA.toJSON()).not.toEqual(simB.toJSON())
  })

  it('keeps the ring radius schedule exactly as configured, the same across every seed', () => {
    const simA = Simulation.create(1, TEST_CONFIG)
    const simB = Simulation.create(2, TEST_CONFIG)

    expect(simA.state.config.ringRadiusSchedule).toEqual(simB.state.config.ringRadiusSchedule)
    expect(simA.state.config.ringRadiusSchedule).toEqual(createConfig().ringRadiusSchedule)
  })

  it('respects an explicit ringRadiusSchedule override', () => {
    const explicit = [8, 5, 2, 0]
    const sim = Simulation.create(1, { ...TEST_CONFIG, ringRadiusSchedule: explicit })
    expect(sim.state.config.ringRadiusSchedule).toEqual(explicit)
  })

  it('still randomizes the ring shrink center per seed even though the radius schedule is fixed', () => {
    const simA = Simulation.create(1, TEST_CONFIG)
    const simB = Simulation.create(2, TEST_CONFIG)
    expect(simA.state.ring.nextCenter).not.toBe(simB.state.ring.nextCenter)
  })

  it('round-trips through toJSON/fromJSON without changing subsequent behavior', () => {
    const commands = { tick: 5, unitId: 2, node: 30 }

    const continuous = Simulation.create(9, TEST_CONFIG)
    const interrupted = Simulation.create(9, TEST_CONFIG)

    for (let t = 1; t <= 10; t++) {
      if (t === commands.tick) {
        continuous.setCommand(commands.unitId, { type: 'moveTo', node: commands.node })
        interrupted.setCommand(commands.unitId, { type: 'moveTo', node: commands.node })
      }
      continuous.step()
      interrupted.step()
    }

    // Serialize/deserialize the interrupted one mid-run, then keep both going identically.
    const resumed = Simulation.fromJSON(interrupted.toJSON())

    for (let t = 11; t <= 40; t++) {
      continuous.step()
      resumed.step()
    }

    expect(resumed.toJSON()).toEqual(continuous.toJSON())
  })

  it('captures a neutral node on arrival via the full step() pipeline', () => {
    const sim = Simulation.create(3, { mapRadius: 8, teamCount: 1, unitsPerTeam: 1 })
    const unit = sim.state.units[0]
    // Head toward a node a few hops away so it's an actual multi-tick journey, not the spawn tile.
    const target = sim.state.nodes.findIndex((n, i) => n.passable && i !== unit.pos.to)
    sim.setCommand(unit.id, { type: 'moveTo', node: target })

    const arrived = () => sim.state.units[0].pos.from === target && sim.state.units[0].pos.to === target
    for (let i = 0; i < 500 && !arrived(); i++) sim.step()
    sim.step() // one extra tick standing on it for territory resolution

    expect(sim.state.nodes[target].owner).toBe(unit.teamId)
  })

  it('captures an intermediate node it merely passed through en route, not just the final destination', () => {
    const sim = Simulation.create(20, { mapRadius: 10, teamCount: 1, unitsPerTeam: 1 })
    const unit = sim.state.units[0]
    const spawnNode = sim.state.nodes[unit.pos.to]
    const destination = sim.state.nodes.findIndex((n, i) => n.passable && i !== unit.pos.to && hexDist(n, spawnNode) >= 3)
    expect(destination).toBeGreaterThanOrEqual(0)

    const path = findPath(sim.state.nodes, sim.state.neighbors, unit.pos.to, destination)
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThanOrEqual(3)
    const intermediateNode = path![Math.floor(path!.length / 2)]

    sim.setCommand(unit.id, { type: 'moveTo', node: destination })
    const arrived = () => sim.state.units[0].pos.from === destination && sim.state.units[0].pos.to === destination
    for (let i = 0; i < 2000 && !arrived(); i++) sim.step()

    expect(arrived()).toBe(true)
    expect(sim.state.nodes[intermediateNode].owner).toBe(unit.teamId)
    expect(sim.state.nodes[destination].owner).toBe(unit.teamId)
  })

  it('wires combat through step(): damage reduces hp and can eliminate a team', () => {
    const sim = Simulation.create(4, {
      mapRadius: 8,
      teamCount: 2,
      unitsPerTeam: 1,
      baseDamage: 500,
      visionRange: 1000,
      attackRange: 1000,
      highGroundK: 0, // isolate combat wiring from the elevation-dependent damage formula (see combat.test.ts)
    })
    const [attacker, victim] = sim.state.units
    sim.setAttackTarget(attacker.id, victim.id)

    expect(isGameOver(sim.state)).toBe(false)

    const events = sim.step()

    expect(sim.state.units.find((u) => u.id === victim.id)?.alive).toBe(false)
    expect(isGameOver(sim.state)).toBe(true)
    expect(getWinnerTeamId(sim.state)).toBe(attacker.teamId)
    const victimTeam = sim.state.teams.find((t) => t.id === victim.teamId)
    expect(victimTeam?.eliminatedAtTick).toBe(sim.state.tick)

    expect(events.combat).toEqual([{ attackerId: attacker.id, targetId: victim.id, damage: 500 }])
    expect(events.deaths).toEqual([{ unitId: victim.id, teamId: victim.teamId, killerTeamId: attacker.teamId }])
    expect(events.eliminatedTeams).toEqual([victim.teamId])

    const attackerTeam = sim.state.teams.find((t) => t.id === attacker.teamId)
    expect(attackerTeam?.killCount).toBe(1)
  })

  it('attributes a kill to whichever team last dealt damage, even across multiple ticks', () => {
    const sim = Simulation.create(10, {
      mapRadius: 10,
      teamCount: 3,
      unitsPerTeam: 1,
      baseDamage: 10,
      visionRange: 1000,
      attackRange: 1000,
      highGroundK: 0,
      // Idle units wander toward a random explore destination each tick (movement.ts's
      // pickExploreDestination fallback), so attackers won't reliably stay "stationary" across
      // ticks; neutralize the facing-dependent multipliers so damage is exactly baseDamage.
      stationaryAttackDamageCoef: 1,
      backAttackDamageCoef: 1,
    })
    const [teamAUnit, victim, teamBUnit] = sim.state.units
    victim.hp = 15 // survives the first 10-damage hit, dies to the second from a different attacking team

    sim.setAttackTarget(teamAUnit.id, victim.id)
    sim.step()
    expect(sim.state.units.find((u) => u.id === victim.id)?.lastDamagedByTeamId).toBe(teamAUnit.teamId)
    expect(sim.state.units.find((u) => u.id === victim.id)?.alive).toBe(true)

    sim.setAttackTarget(teamAUnit.id, null)
    sim.setAttackTarget(teamBUnit.id, victim.id)
    const events = sim.step()

    expect(events.deaths).toEqual([{ unitId: victim.id, teamId: victim.teamId, killerTeamId: teamBUnit.teamId }])
    expect(sim.state.teams.find((t) => t.id === teamAUnit.teamId)?.killCount).toBe(0)
    expect(sim.state.teams.find((t) => t.id === teamBUnit.teamId)?.killCount).toBe(1)
  })

  it('a death caused purely by ring slip damage (no prior combat) attributes to no team and grants no kill credit', () => {
    const sim = Simulation.create(11, {
      mapRadius: 8,
      teamCount: 2,
      unitsPerTeam: 1,
      unitHP: 1,
      baseDamage: 0, // no combat damage is possible; only ring slip damage can kill
    })
    const victim = sim.state.units[0]
    // Force every unit outside the ring with maximal slip damage, bypassing the shrink schedule
    // (both teams' lone units die this way, since nothing here is team-specific).
    sim.state.ring.activeRadius = -1
    sim.state.ring.phase = 'done'
    sim.state.ring.stage = sim.state.config.slipDamage.length - 1

    const events = sim.step()

    expect(events.deaths).toContainEqual({ unitId: victim.id, teamId: victim.teamId, killerTeamId: null })
    for (const team of sim.state.teams) expect(team.killCount).toBe(0)
  })

  it('remains fully deterministic with combat/territory/ring all active', () => {
    function run(): ReturnType<Simulation['toJSON']> {
      const sim = Simulation.create(55, {
        mapRadius: 8,
        teamCount: 3,
        unitsPerTeam: 2,
        warnTicks: 10,
        shrinkTicks: 15,
        ringRadiusSchedule: [8, 5, 2, 0],
      })
      for (let t = 1; t <= 200; t++) {
        if (t === 3) {
          sim.setCommand(0, { type: 'moveTo', node: 10 })
          sim.setAttackTarget(0, 3)
        }
        if (t === 40) {
          sim.setCommand(3, { type: 'moveTo', node: 20 })
          sim.setAttackTarget(3, 0)
        }
        sim.step()
      }
      return sim.toJSON()
    }

    const a = run()
    const b = run()
    expect(a).toEqual(b)
  })
})
