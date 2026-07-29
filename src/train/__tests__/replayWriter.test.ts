import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defaultConfig } from '../../sim'
import { pruneReplays, saveReplay } from '../replayWriter'
import type { RecordedReplay } from '../replayRecording'

function makeReplay(overrides?: Partial<RecordedReplay>): RecordedReplay {
  return {
    iteration: 1,
    opponentBotKind: 'expander',
    seed: 1,
    simConfig: defaultConfig(),
    log: [{ tick: 0, commands: [] }],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('saveReplay', () => {
  it('writes the replay JSON file and a manifest entry pointing to it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-replay-writer-test-'))
    try {
      const replay = makeReplay({ iteration: 10, opponentBotKind: 'guardian' })
      const entry = saveReplay(replay, dir)

      expect(entry.filename).toBe('iter-10-vs-guardian.json')
      expect(fs.existsSync(path.join(dir, entry.filename))).toBe(true)

      const written = JSON.parse(fs.readFileSync(path.join(dir, entry.filename), 'utf-8'))
      expect(written).toEqual(replay)

      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
      expect(manifest).toEqual([entry])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses a "-selfplay" filename (no "-vs-") for a selfPlay replay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-replay-writer-test-'))
    try {
      const entry = saveReplay(makeReplay({ iteration: 20, opponentBotKind: 'selfPlay' }), dir)
      expect(entry.filename).toBe('iter-20-selfplay.json')
      expect(fs.existsSync(path.join(dir, entry.filename))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appends to an existing manifest rather than overwriting it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-replay-writer-test-'))
    try {
      const first = saveReplay(makeReplay({ iteration: 1 }), dir)
      const second = saveReplay(makeReplay({ iteration: 2 }), dir)

      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
      expect(manifest).toEqual([first, second])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates the replays directory if it does not exist yet', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-replay-writer-test-'))
    const nested = path.join(base, 'nested', 'replays')
    try {
      expect(fs.existsSync(nested)).toBe(false)
      saveReplay(makeReplay(), nested)
      expect(fs.existsSync(nested)).toBe(true)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('pruneReplays', () => {
  it('deletes manifest entries and files whose iteration is not in the keep set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-replay-writer-test-'))
    try {
      const e20 = saveReplay(makeReplay({ iteration: 20 }), dir)
      const e40 = saveReplay(makeReplay({ iteration: 40 }), dir)
      const e60 = saveReplay(makeReplay({ iteration: 60 }), dir)

      const deleted = pruneReplays(dir, new Set([20, 60]))

      expect(deleted).toEqual([e40.filename])
      expect(fs.existsSync(path.join(dir, e20.filename))).toBe(true)
      expect(fs.existsSync(path.join(dir, e40.filename))).toBe(false)
      expect(fs.existsSync(path.join(dir, e60.filename))).toBe(true)

      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
      expect(manifest).toEqual([e20, e60])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps multiple matchup entries for the same surviving iteration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-replay-writer-test-'))
    try {
      const kept = saveReplay(makeReplay({ iteration: 20, opponentBotKind: 'expander' }), dir)
      const alsoKept = saveReplay(makeReplay({ iteration: 20, opponentBotKind: 'guardian' }), dir)
      const dropped = saveReplay(makeReplay({ iteration: 40, opponentBotKind: 'expander' }), dir)

      const deleted = pruneReplays(dir, new Set([20]))

      expect(deleted).toEqual([dropped.filename])
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
      expect(manifest).toEqual([kept, alsoKept])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does nothing when there is no manifest yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-replay-writer-test-'))
    try {
      expect(pruneReplays(dir, new Set([1]))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not rewrite the manifest when nothing needed pruning', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayhem-replay-writer-test-'))
    try {
      saveReplay(makeReplay({ iteration: 20 }), dir)
      const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')

      expect(pruneReplays(dir, new Set([20]))).toEqual([])
      expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
