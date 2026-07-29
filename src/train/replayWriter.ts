import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RecordedReplay } from './replayRecording'

export interface ReplayManifestEntry {
  iteration: number
  opponentBotKind: string
  filename: string
  createdAt: string
}

/**
 * `replaysDir`に想定しているのは`public/replays`(Viteの開発サーバー/ビルド出力がそのまま
 * 静的配信する場所) — `npm run dev`を起動しておけば、ブラウザ側は`/replays/manifest.json`と
 * `/replays/<filename>`をfetchでそのまま読める。`manifest.json`は既存があれば読み込んで
 * 追記する(学習の反復ごとに1件ずつ増えていく前提)。
 */
export function saveReplay(replay: RecordedReplay, replaysDir: string): ReplayManifestEntry {
  fs.mkdirSync(replaysDir, { recursive: true })

  const filename =
    replay.opponentBotKind === 'selfPlay'
      ? `iter-${replay.iteration}-selfplay.json`
      : `iter-${replay.iteration}-vs-${replay.opponentBotKind}.json`
  fs.writeFileSync(path.join(replaysDir, filename), JSON.stringify(replay))

  const manifestPath = path.join(replaysDir, 'manifest.json')
  const manifest: ReplayManifestEntry[] = fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ReplayManifestEntry[])
    : []

  const entry: ReplayManifestEntry = {
    iteration: replay.iteration,
    opponentBotKind: replay.opponentBotKind,
    filename,
    createdAt: replay.createdAt,
  }
  manifest.push(entry)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  return entry
}

/**
 * ユーザー要望: チェックポイントの間引き(`checkpointPruning.ts`)で消えた世代のリプレイは
 * `public/replays`側にも残さない — ブラウザの学習リプレイ一覧(`TrainingReplayPanel.tsx`)には
 * 現在保持しているチェックポイント世代のリプレイだけを表示させる。`keepIterations`に含まれない
 * `iteration`のエントリをmanifestとファイルの両方から取り除き、削除したファイル名の一覧を返す
 * (ロギング用)。`manifest.json`が無ければ何もしない(まだ1件もリプレイが無い状態)。
 */
export function pruneReplays(replaysDir: string, keepIterations: ReadonlySet<number>): string[] {
  const manifestPath = path.join(replaysDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return []

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ReplayManifestEntry[]
  const kept: ReplayManifestEntry[] = []
  const deletedFilenames: string[] = []

  for (const entry of manifest) {
    if (keepIterations.has(entry.iteration)) {
      kept.push(entry)
      continue
    }
    const filePath = path.join(replaysDir, entry.filename)
    if (fs.existsSync(filePath)) fs.rmSync(filePath)
    deletedFilenames.push(entry.filename)
  }

  if (deletedFilenames.length > 0) {
    fs.writeFileSync(manifestPath, JSON.stringify(kept, null, 2))
  }

  return deletedFilenames
}
