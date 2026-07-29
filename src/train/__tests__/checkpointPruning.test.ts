import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { listCheckpoints, meanWinRate, pruneCheckpoints, selectCheckpointsToKeep } from '../checkpointPruning'
import type { CheckpointInfo } from '../checkpointPruning'
import type { EvalReport } from '../types'

const DIR_PATTERN = /^iter-\d+$/

function makeCheckpointDir(root: string, name: string, iteration: number, score: number | null): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ iteration, score }))
}

describe('meanWinRate', () => {
  it('averages winRate across all matchups', () => {
    const report: EvalReport = {
      iteration: 1,
      matchups: [
        { opponentBotKind: 'expander', episodes: 5, winRate: 0.4, avgRank: 1 },
        { opponentBotKind: 'guardian', episodes: 5, winRate: 0.8, avgRank: 1 },
      ],
    }
    expect(meanWinRate(report)).toBeCloseTo(0.6, 10)
  })

  it('returns 0 for an empty matchup list', () => {
    expect(meanWinRate({ iteration: 1, matchups: [] })).toBe(0)
  })
})

describe('selectCheckpointsToKeep', () => {
  it('always keeps the highest-iteration checkpoint, even if its score is the worst', () => {
    const checkpoints: CheckpointInfo[] = [
      { dir: 'a', iteration: 20, score: 0.9 },
      { dir: 'b', iteration: 40, score: 0.1 }, // latest, but worst score
    ]
    const keep = selectCheckpointsToKeep(checkpoints, 1)
    expect(keep.has('b')).toBe(true)
  })

  it('keeps the top-N by score in addition to the latest', () => {
    const checkpoints: CheckpointInfo[] = [
      { dir: 'a', iteration: 20, score: 0.9 },
      { dir: 'b', iteration: 40, score: 0.2 },
      { dir: 'c', iteration: 60, score: 0.5 },
      { dir: 'd', iteration: 80, score: 0.1 }, // latest
    ]
    const keep = selectCheckpointsToKeep(checkpoints, 2)
    expect(keep).toEqual(new Set(['d', 'a', 'c'])) // latest(d) + top-2 by score(a, c)
  })

  it('treats unscored (null) checkpoints as lowest priority', () => {
    const checkpoints: CheckpointInfo[] = [
      { dir: 'a', iteration: 20, score: null },
      { dir: 'b', iteration: 40, score: 0.5 },
      { dir: 'c', iteration: 60, score: null }, // latest
    ]
    const keep = selectCheckpointsToKeep(checkpoints, 1)
    expect(keep).toEqual(new Set(['c', 'b'])) // latest(c) + top-1 by score(b); 'a' loses the tie on null score
  })

  it('returns an empty set for an empty input', () => {
    expect(selectCheckpointsToKeep([], 3)).toEqual(new Set())
  })
})

describe('listCheckpoints / pruneCheckpoints (filesystem)', () => {
  it('lists only directories matching the pattern that have a meta.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-prune-test-'))
    try {
      makeCheckpointDir(root, 'iter-20', 20, 0.3)
      makeCheckpointDir(root, 'iter-40', 40, 0.7)
      fs.mkdirSync(path.join(root, '_tfjs_template'), { recursive: true }) // no meta.json, wrong name
      fs.mkdirSync(path.join(root, 'iter-60')) // matches pattern but no meta.json yet

      const checkpoints = listCheckpoints(root, DIR_PATTERN)
      expect(checkpoints).toHaveLength(2)
      expect(checkpoints.map((c) => c.iteration).sort()).toEqual([20, 40])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('regression: a combined `/^(py-)?iter-\\d+$/` pattern sees both TS and Python checkpoint dirs together — required so trainPPO.ts/train_ppo.py can compute a replay keep-set that spans both pipelines, not just their own (a prior bug scoped this to one pipeline\'s own pattern and deleted the other pipeline\'s still-live replays)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-prune-test-'))
    try {
      makeCheckpointDir(root, 'iter-20', 20, 0.5)
      makeCheckpointDir(root, 'py-iter-880', 880, 0.6)
      makeCheckpointDir(root, 'py-iter-1120', 1120, 0.4)

      const anyPattern = /^(py-)?iter-\d+$/
      const checkpoints = listCheckpoints(root, anyPattern)
      expect(checkpoints.map((c) => c.iteration).sort((a, b) => a - b)).toEqual([20, 880, 1120])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes everything outside the keep set and returns the deleted directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-prune-test-'))
    try {
      makeCheckpointDir(root, 'iter-20', 20, 0.9)
      makeCheckpointDir(root, 'iter-40', 40, 0.2)
      makeCheckpointDir(root, 'iter-60', 60, 0.5)
      makeCheckpointDir(root, 'iter-80', 80, 0.1) // latest, worst score

      const deleted = pruneCheckpoints(root, DIR_PATTERN, 1)

      expect(fs.existsSync(path.join(root, 'iter-80'))).toBe(true) // latest, always kept
      expect(fs.existsSync(path.join(root, 'iter-20'))).toBe(true) // best score, kept
      expect(fs.existsSync(path.join(root, 'iter-40'))).toBe(false)
      expect(fs.existsSync(path.join(root, 'iter-60'))).toBe(false)
      expect(deleted.sort()).toEqual([path.join(root, 'iter-40'), path.join(root, 'iter-60')].sort())
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does nothing when the checkpoint directory does not exist', () => {
    expect(pruneCheckpoints(path.join(os.tmpdir(), 'mayhem-does-not-exist'), DIR_PATTERN, 3)).toEqual([])
  })
})
