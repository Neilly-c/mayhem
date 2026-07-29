import type { NodeState } from './types'
import { hexDist } from './hexgrid'

class MinHeap {
  private readonly items: { node: number; priority: number }[] = []

  get size(): number {
    return this.items.length
  }

  push(node: number, priority: number): void {
    const items = this.items
    items.push({ node, priority })
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent].priority <= items[i].priority) break
      ;[items[parent], items[i]] = [items[i], items[parent]]
      i = parent
    }
  }

  pop(): number | undefined {
    const items = this.items
    if (items.length === 0) return undefined
    const top = items[0]
    const last = items.pop() as { node: number; priority: number }
    if (items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const left = i * 2 + 1
        const right = i * 2 + 2
        let smallest = i
        if (left < items.length && items[left].priority < items[smallest].priority) smallest = left
        if (right < items.length && items[right].priority < items[smallest].priority) smallest = right
        if (smallest === i) break
        ;[items[smallest], items[i]] = [items[i], items[smallest]]
        i = smallest
      }
    }
    return top.node
  }
}

/**
 * A* over passable nodes. `hexDist` is an admissible & consistent heuristic since every
 * edge has uniform cost 1 and the hop distance is a lower bound on the number of edges.
 * Returns the path from `start` to `goal` excluding `start`, or null if unreachable.
 *
 * ユーザー要望: `blocked`(他ユニットが占有中のノード)を渡すと、それらを迂回する経路を探す
 * (`start`自身は`blocked`に含まれていても常に許可 — 自分の現在地を自分自身が塞ぐことはない)。
 * `goal`が`blocked`なら即座に`null`(今は誰かが占有しているノードへは経路を引けない)。
 */
export function findPath(
  nodes: NodeState[],
  neighbors: number[][],
  start: number,
  goal: number,
  blocked?: ReadonlySet<number>,
): number[] | null {
  if (start === goal) return []
  if (!nodes[start].passable || !nodes[goal].passable) return null
  if (blocked?.has(goal)) return null

  const goalNode = nodes[goal]
  const heuristic = (i: number): number => hexDist(nodes[i], goalNode)

  const gScore = new Map<number, number>([[start, 0]])
  const cameFrom = new Map<number, number>()
  const open = new MinHeap()
  open.push(start, heuristic(start))
  const closed = new Set<number>()

  while (open.size > 0) {
    const current = open.pop() as number
    if (current === goal) {
      const path: number[] = []
      let node = current
      while (node !== start) {
        path.push(node)
        node = cameFrom.get(node) as number
      }
      path.reverse()
      return path
    }
    if (closed.has(current)) continue
    closed.add(current)

    const currentG = gScore.get(current) as number
    for (const next of neighbors[current]) {
      if (closed.has(next)) continue
      if (blocked?.has(next) && next !== goal) continue
      const tentativeG = currentG + 1
      if (tentativeG < (gScore.get(next) ?? Infinity)) {
        gScore.set(next, tentativeG)
        cameFrom.set(next, current)
        open.push(next, tentativeG + heuristic(next))
      }
    }
  }
  return null
}
