import type { NodeState, SimConfig } from './types'
import { DIRECTIONS, axialAdd, axialKey, nodesInRadius, world } from './hexgrid'
import { deriveRng } from './rng'
import { PerlinNoise2D } from './noise'

export interface MapData {
  nodes: NodeState[]
  /** neighbors[i] = indices of passable nodes adjacent to node i (empty for wall nodes). */
  neighbors: number[][]
}

/**
 * §2.2 マップ生成: ノード生成 → Perlin標高 → 閾値による壁判定 → 最大連結成分のみ採用
 * (孤立小島は壁化) → 通行可能ノード同士のみ辺を張る。
 */
export function generateMap(seed: number, config: SimConfig): MapData {
  const coords = nodesInRadius(config.mapRadius)
  const indexByKey = new Map<string, number>()
  coords.forEach((c, i) => indexByKey.set(axialKey(c), i))

  const noise = new PerlinNoise2D(deriveRng(seed, 'elevation'))

  const nodes: NodeState[] = coords.map((c) => {
    const w = world(c)
    const elevation = noise.normalized(w.x * config.perlinFrequency, w.y * config.perlinFrequency)
    return {
      q: c.q,
      r: c.r,
      elevation,
      passable: elevation >= config.wallThreshold,
      owner: null,
      captureProgress: null,
    }
  })

  const rawNeighbors = (i: number): number[] => {
    const c = coords[i]
    const result: number[] = []
    for (const d of DIRECTIONS) {
      const idx = indexByKey.get(axialKey(axialAdd(c, d)))
      if (idx !== undefined) result.push(idx)
    }
    return result
  }

  // Largest connected component among passable nodes (hex-adjacency BFS).
  const visited = new Uint8Array(nodes.length)
  let largestComponent: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].passable || visited[i]) continue
    const stack = [i]
    visited[i] = 1
    const component: number[] = []
    while (stack.length > 0) {
      const cur = stack.pop() as number
      component.push(cur)
      for (const n of rawNeighbors(cur)) {
        if (nodes[n].passable && !visited[n]) {
          visited[n] = 1
          stack.push(n)
        }
      }
    }
    if (component.length > largestComponent.length) largestComponent = component
  }

  const inLargest = new Uint8Array(nodes.length)
  for (const i of largestComponent) inLargest[i] = 1
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].passable && !inLargest[i]) {
      nodes[i] = { ...nodes[i], passable: false }
    }
  }

  const neighbors: number[][] = nodes.map((node, i) =>
    node.passable ? rawNeighbors(i).filter((n) => nodes[n].passable) : [],
  )

  return { nodes, neighbors }
}
