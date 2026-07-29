import { describe, expect, it } from 'vitest'
import { pickBestCheckpoint, pickLatestCheckpoint, type CheckpointInfo } from '../policyModel'

function makeCheckpoint(dir: string, iteration: number, score: number | null): CheckpointInfo {
  return { dir, iteration, score, createdAt: new Date(0).toISOString() }
}

describe('pickLatestCheckpoint', () => {
  it('picks the checkpoint with the highest iteration, regardless of score', () => {
    const checkpoints = [makeCheckpoint('iter-20', 20, 0.9), makeCheckpoint('py-iter-40', 40, 0.1)]
    expect(pickLatestCheckpoint(checkpoints)?.dir).toBe('py-iter-40')
  })

  it('returns null for an empty list', () => {
    expect(pickLatestCheckpoint([])).toBeNull()
  })
})

describe('pickBestCheckpoint', () => {
  it('picks the checkpoint with the highest score', () => {
    const checkpoints = [makeCheckpoint('iter-20', 20, 0.9), makeCheckpoint('py-iter-40', 40, 0.1)]
    expect(pickBestCheckpoint(checkpoints)?.dir).toBe('iter-20')
  })

  it('ignores unscored (null) checkpoints in favor of any scored one', () => {
    const checkpoints = [makeCheckpoint('iter-20', 20, null), makeCheckpoint('py-iter-40', 40, 0.1)]
    expect(pickBestCheckpoint(checkpoints)?.dir).toBe('py-iter-40')
  })

  it('returns null when no checkpoint has a score', () => {
    const checkpoints = [makeCheckpoint('iter-20', 20, null), makeCheckpoint('py-iter-40', 40, null)]
    expect(pickBestCheckpoint(checkpoints)).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(pickBestCheckpoint([])).toBeNull()
  })
})
