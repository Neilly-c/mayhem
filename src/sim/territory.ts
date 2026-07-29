import type { GameState } from './types'

/**
 * §6 テリトリー: 各tick、ノードごとに解決する。
 * - 中立ノード: 「実際に滞在中(`from===to`)」のユニットに加え、`passedThroughNodes`(このtick
 *   中に到達したが通過して別の辺へ進んだユニット、§6「通過した瞬間に即座に」)も対象チームに含め、
 *   単独チームなら即時奪取する。
 * - 敵(所有済み)ノード: 通過しただけでは奪えないため、`from===to`で実際に滞在中のチームのみで
 *   `captureTicks`到達による占領進行・離脱リセット・係争(`contestedCaptureBehavior`)を解決する。
 * 戻り値は、このtickで`owner`が実際に変化したノード(§11.4の報酬「新規占有ノード」の生の素材)。
 */
export function resolveTerritory(
  state: GameState,
  passedThroughNodes: { teamId: number; node: number }[],
): { node: number; teamId: number }[] {
  const stationaryTeams: Set<number>[] = state.nodes.map(() => new Set<number>())
  for (const unit of state.units) {
    if (unit.alive && unit.pos.from === unit.pos.to) {
      stationaryTeams[unit.pos.to].add(unit.teamId)
    }
  }

  const neutralEligibleTeams: Set<number>[] = stationaryTeams.map((teams) => new Set(teams))
  for (const { teamId, node } of passedThroughNodes) {
    neutralEligibleTeams[node].add(teamId)
  }

  const captures: { node: number; teamId: number }[] = []

  for (let i = 0; i < state.nodes.length; i++) {
    const node = state.nodes[i]
    const ownerBefore = node.owner

    if (node.owner === null) {
      // Neutral: only an uncontested single team (stationary or merely passing through) claims it.
      const eligible = neutralEligibleTeams[i]
      if (eligible.size === 1) {
        node.owner = [...eligible][0]
      }
    } else {
      const teams = stationaryTeams[i]
      if (teams.size === 0) {
        if (node.captureProgress !== null) node.captureProgress = null
      } else if (teams.size === 1 && teams.has(node.owner)) {
        // owner alone on their own node; nothing to do
      } else if (teams.size === 1) {
        const attacker = [...teams][0]
        if (node.captureProgress && node.captureProgress.teamId === attacker) {
          const ticks = node.captureProgress.ticks + 1
          if (ticks >= state.config.captureTicks) {
            node.owner = attacker
            node.captureProgress = null
          } else {
            node.captureProgress = { teamId: attacker, ticks }
          }
        } else {
          node.captureProgress = { teamId: attacker, ticks: 1 }
        }
      } else {
        // Contested: 2+ teams present (owner + attacker(s), or multiple attackers).
        if (state.config.contestedCaptureBehavior === 'reset') {
          node.captureProgress = null
        }
        // 'freeze' (default): leave captureProgress untouched.
      }
    }

    if (node.owner !== ownerBefore && node.owner !== null) {
      captures.push({ node: i, teamId: node.owner })
    }
  }

  return captures
}
