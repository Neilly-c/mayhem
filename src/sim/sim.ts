import type { GameState, MoveCommand, SimConfig, TickEvents } from './types'
import { createConfig } from './config'
import { generateMap } from './mapgen'
import { createTeamsAndUnits } from './entities'
import { computeMovementIntent, applyMovementIntent } from './movement'
import { computeCombatIntents, applyCombatIntent, type CombatIntent } from './combat'
import { resolveTerritory } from './territory'
import { initRingState, tickRing, applySlipDamage } from './ring'
import { applyRegen } from './regen'

/**
 * Headless, deterministic simulation core (§1). Owns no DOM/React state — `state` is plain,
 * JSON-serializable data throughout.
 */
export class Simulation {
  state: GameState

  private constructor(state: GameState) {
    this.state = state
  }

  /**
   * ユーザー要望: リングの半径推移(`ringRadiusSchedule`)は常に固定。ランダム性は中心座標の
   * 選択(`ring.ts`の`pickNextCenter`)側だけが担う — そちらはseedから決定的に導出されるので、
   * seedが変われば収縮の軌道は変わるが、各段階の安全半径そのものは常に`config`通りになる。
   */
  static create(seed: number, overrides?: Partial<SimConfig>): Simulation {
    const config = createConfig(overrides)
    const { nodes, neighbors } = generateMap(seed, config)
    const { teams, units } = createTeamsAndUnits(seed, config, nodes, neighbors)
    const ring = initRingState(seed, config, nodes)
    return new Simulation({ seed, tick: 0, config, nodes, neighbors, teams, units, ring })
  }

  /**
   * §4.2 二相更新。各サブフェーズ(移動→戦闘→テリトリー→リング→死亡判定)はtick開始時点の
   * `alive`スナップショットに対して(teamId,unitId)昇順で適用し、死亡判定は最後に一度だけ
   * まとめて行う。これにより同一tickの相打ちや「致死ダメージ後もそのtickの間は占領判定に
   * 参加する」といった挙動が処理順に依存せず常に同じ結果になる。
   */
  step(): TickEvents {
    this.state.tick++

    const order = this.state.units
      .filter((u) => u.alive)
      .sort((a, b) => a.teamId - b.teamId || a.id - b.id)

    const moveIntents = order.map((unit) => ({
      unit,
      intent: computeMovementIntent(this.state, unit),
    }))
    const passedThroughNodes: { teamId: number; node: number }[] = []
    for (const { unit, intent } of moveIntents) {
      if (!intent) continue
      const visited = applyMovementIntent(this.state, unit, intent)
      for (const node of visited) passedThroughNodes.push({ teamId: unit.teamId, node })
    }

    const combatIntents: CombatIntent[] = []
    for (const unit of order) {
      combatIntents.push(...computeCombatIntents(this.state, unit))
    }
    for (const intent of combatIntents) applyCombatIntent(this.state, intent)

    const territoryCaptures = resolveTerritory(this.state, passedThroughNodes)
    const regen = applyRegen(this.state)

    tickRing(this.state)
    const slipDamage = applySlipDamage(this.state)

    const deaths: TickEvents['deaths'] = []
    for (const unit of this.state.units) {
      if (unit.alive && unit.hp <= 0) {
        unit.alive = false
        const killerTeamId = unit.lastDamagedByTeamId
        if (killerTeamId !== null) {
          const killerTeam = this.state.teams.find((t) => t.id === killerTeamId)
          if (killerTeam) killerTeam.killCount++
        }
        deaths.push({ unitId: unit.id, teamId: unit.teamId, killerTeamId })
      }
    }
    const eliminatedTeams: number[] = []
    for (const team of this.state.teams) {
      if (team.alive && !this.state.units.some((u) => u.teamId === team.id && u.alive)) {
        team.alive = false
        team.eliminatedAtTick = this.state.tick
        eliminatedTeams.push(team.id)
      }
    }

    return {
      combat: combatIntents,
      deaths,
      eliminatedTeams,
      territoryCaptures,
      regen,
      slipDamage,
    }
  }

  setCommand(unitId: number, command: MoveCommand): void {
    const unit = this.state.units.find((u) => u.id === unitId)
    if (unit) unit.command = command
  }

  setAttackTarget(unitId: number, targetUnitId: number | null): void {
    const unit = this.state.units.find((u) => u.id === unitId)
    if (unit) unit.attackTarget = targetUnitId
  }

  toJSON(): GameState {
    return JSON.parse(JSON.stringify(this.state)) as GameState
  }

  static fromJSON(data: GameState): Simulation {
    return new Simulation(JSON.parse(JSON.stringify(data)) as GameState)
  }
}
