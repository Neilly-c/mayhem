import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EvalReport } from './types'

/** 全対戦相手の勝率の単純平均。チェックポイントの優劣を1つのスカラーに集約する既定の指標。 */
export function meanWinRate(report: EvalReport): number {
  if (report.matchups.length === 0) return 0
  return report.matchups.reduce((sum, m) => sum + m.winRate, 0) / report.matchups.length
}

export interface CheckpointInfo {
  dir: string
  iteration: number
  score: number | null
}

/** `checkpointDir`直下で`dirPattern`に一致するサブディレクトリのうち、`meta.json`を持つものを
 * 列挙する(`_tfjs_template`など無関係なディレクトリは`dirPattern`で自然に除外される)。 */
export function listCheckpoints(checkpointDir: string, dirPattern: RegExp): CheckpointInfo[] {
  if (!fs.existsSync(checkpointDir)) return []
  const checkpoints: CheckpointInfo[] = []
  for (const entry of fs.readdirSync(checkpointDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !dirPattern.test(entry.name)) continue
    const dir = path.join(checkpointDir, entry.name)
    const metaPath = path.join(dir, 'meta.json')
    if (!fs.existsSync(metaPath)) continue
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { iteration: number; score?: number | null }
    checkpoints.push({ dir, iteration: meta.iteration, score: meta.score ?? null })
  }
  return checkpoints
}

/**
 * ユーザー要望: 世代を追うごとに増え続けるチェックポイントを抑制する。最新1件(必ず保護)に加え、
 * `score`降順で上位`keepTopN`件を残す。`score`が無い(未評価)チェックポイントは順位付け上
 * 最下位扱いとし、最新として保護される場合を除き優先的に削除対象になる。
 */
export function selectCheckpointsToKeep(checkpoints: CheckpointInfo[], keepTopN: number): Set<string> {
  if (checkpoints.length === 0) return new Set()
  const keep = new Set<string>()

  const latest = checkpoints.reduce((a, b) => (b.iteration > a.iteration ? b : a))
  keep.add(latest.dir)

  const byScoreDesc = [...checkpoints].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
  for (const c of byScoreDesc.slice(0, Math.max(0, keepTopN))) keep.add(c.dir)

  return keep
}

/** 保持対象外になったチェックポイントディレクトリを削除し、削除したパスの一覧を返す(ロギング用)。 */
export function pruneCheckpoints(checkpointDir: string, dirPattern: RegExp, keepTopN: number): string[] {
  const checkpoints = listCheckpoints(checkpointDir, dirPattern)
  const keep = selectCheckpointsToKeep(checkpoints, keepTopN)
  const deleted: string[] = []
  for (const c of checkpoints) {
    if (keep.has(c.dir)) continue
    fs.rmSync(c.dir, { recursive: true, force: true })
    deleted.push(c.dir)
  }
  return deleted
}
