import { describe, expect, it } from 'vitest'
import type { NodeState } from '../types'
import { findPath } from '../pathfinding'

function makeNode(q: number, r: number, passable = true): NodeState {
  return { q, r, elevation: 0.5, passable, owner: null, captureProgress: null }
}

describe('findPath', () => {
  it('returns an empty array when start equals goal', () => {
    const nodes = [makeNode(0, 0)]
    expect(findPath(nodes, [[]], 0, 0)).toEqual([])
  })

  it('returns null when start or goal is not passable', () => {
    const nodes = [makeNode(0, 0), makeNode(1, 0, false)]
    const neighbors = [[1], [0]]
    expect(findPath(nodes, neighbors, 0, 1)).toBeNull()
    expect(findPath(nodes, neighbors, 1, 0)).toBeNull()
  })

  it('finds the direct path along a line', () => {
    const nodes = [makeNode(0, 0), makeNode(1, 0), makeNode(2, 0)]
    const neighbors = [[1], [0, 2], [1]]
    expect(findPath(nodes, neighbors, 0, 2)).toEqual([1, 2])
  })

  it('returns null when the goal is unreachable (disconnected graph)', () => {
    const nodes = [makeNode(0, 0), makeNode(5, 0)]
    const neighbors = [[], []]
    expect(findPath(nodes, neighbors, 0, 1)).toBeNull()
  })

  it('routes around a wall pocket when a direct route is blocked', () => {
    // 0 branches to 1 (direct, but 1 is a wall) and 2 (detour); both eventually reach goal 3.
    const nodes = [makeNode(0, 0), makeNode(1, 0, false), makeNode(0, 1), makeNode(1, 1)]
    const neighbors = [
      [2], // 0 -> only the detour (1 is a wall, so mapgen-style neighbor lists would never include it)
      [], // 1: unreachable wall, no edges either way
      [0, 3], // 2
      [2], // 3 (goal)
    ]
    expect(findPath(nodes, neighbors, 0, 3)).toEqual([2, 3])
  })

  it('respects the `blocked` set, treating those nodes as temporarily impassable', () => {
    const nodes = [makeNode(0, 0), makeNode(1, 0), makeNode(2, 0), makeNode(1, 1)]
    // 0 - 1 - 2 direct line, plus a detour 0 - 3 - 2.
    const neighbors = [
      [1, 3],
      [0, 2],
      [1, 3],
      [0, 2],
    ]
    expect(findPath(nodes, neighbors, 0, 2)).toEqual([1, 2]) // direct route when nothing is blocked
    expect(findPath(nodes, neighbors, 0, 2, new Set([1]))).toEqual([3, 2]) // reroutes around the blocked node
  })

  it('returns null immediately when the goal itself is blocked', () => {
    const nodes = [makeNode(0, 0), makeNode(1, 0)]
    const neighbors = [[1], [0]]
    expect(findPath(nodes, neighbors, 0, 1, new Set([1]))).toBeNull()
  })

  it('never treats `start` as blocked even if it is present in the `blocked` set', () => {
    const nodes = [makeNode(0, 0), makeNode(1, 0)]
    const neighbors = [[1], [0]]
    expect(findPath(nodes, neighbors, 0, 1, new Set([0]))).toEqual([1])
  })
})
