import { describe, expect, it } from 'vitest'
import { createConfig } from '../config'
import { generateMap } from '../mapgen'

function assertSingleConnectedComponent(nodes: { passable: boolean }[], neighbors: number[][]) {
  const passableIndices = nodes.reduce<number[]>((acc, n, i) => {
    if (n.passable) acc.push(i)
    return acc
  }, [])
  expect(passableIndices.length).toBeGreaterThan(0)

  const visited = new Set<number>()
  const stack = [passableIndices[0]]
  visited.add(passableIndices[0])
  while (stack.length > 0) {
    const cur = stack.pop() as number
    for (const n of neighbors[cur]) {
      if (!visited.has(n)) {
        visited.add(n)
        stack.push(n)
      }
    }
  }
  expect(visited.size).toBe(passableIndices.length)
}

describe('mapgen', () => {
  it('generates the expected node count for the configured radius', () => {
    const config = createConfig({ mapRadius: 10 })
    const { nodes } = generateMap(1, config)
    expect(nodes.length).toBe(1 + 3 * 10 * 11)
  })

  it('is fully deterministic for a given seed', () => {
    const config = createConfig({ mapRadius: 12 })
    const a = generateMap(555, config)
    const b = generateMap(555, config)
    expect(a.nodes).toEqual(b.nodes)
    expect(a.neighbors).toEqual(b.neighbors)
  })

  it('produces different maps for different seeds', () => {
    const config = createConfig({ mapRadius: 12 })
    const a = generateMap(1, config)
    const b = generateMap(2, config)
    expect(a.nodes).not.toEqual(b.nodes)
  })

  it('guarantees all passable nodes form a single connected component', () => {
    const config = createConfig({ mapRadius: 15 })
    for (const seed of [1, 2, 3, 42, 12345]) {
      const { nodes, neighbors } = generateMap(seed, config)
      assertSingleConnectedComponent(nodes, neighbors)
    }
  })

  it('neighbors only ever point at passable nodes, and are symmetric', () => {
    const config = createConfig({ mapRadius: 12 })
    const { nodes, neighbors } = generateMap(7, config)
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].passable) {
        expect(neighbors[i]).toEqual([])
        continue
      }
      for (const n of neighbors[i]) {
        expect(nodes[n].passable).toBe(true)
        expect(neighbors[n]).toContain(i)
      }
    }
  })

  it('wall ratio averages roughly ~30% at default config, allowing wide per-seed variance (§2.2)', () => {
    const config = createConfig({ mapRadius: 25 })
    const seeds = [12345, 1, 2, 999, 42, 7, 88]
    let total = 0
    let walls = 0
    for (const seed of seeds) {
      const { nodes } = generateMap(seed, config)
      total += nodes.length
      walls += nodes.filter((n) => !n.passable).length
    }
    const avgWallRatio = walls / total
    expect(avgWallRatio).toBeGreaterThan(0.15)
    expect(avgWallRatio).toBeLessThan(0.5)
  })

  it('elevation values stay within [0, 1]', () => {
    const config = createConfig({ mapRadius: 10 })
    const { nodes } = generateMap(3, config)
    for (const n of nodes) {
      expect(n.elevation).toBeGreaterThanOrEqual(0)
      expect(n.elevation).toBeLessThanOrEqual(1)
    }
  })
})
