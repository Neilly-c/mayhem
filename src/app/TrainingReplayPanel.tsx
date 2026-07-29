import { useCallback, useEffect, useRef, useState } from 'react'
import type { SimConfig } from '../sim'
import type { LoggedDecision } from './replay'

interface ManifestEntry {
  iteration: number
  opponentBotKind: string
  filename: string
  createdAt: string
}

interface ReplayFile {
  seed: number
  simConfig: SimConfig
  log: LoggedDecision[]
}

interface Props {
  onLoadReplay: (seed: number, simConfig: SimConfig, log: LoggedDecision[]) => void
}

const REPLAYS_BASE = '/replays'
const POLL_INTERVAL_MS = 5000

/**
 * ユーザー要望: 学習(`npm run train`)が`public/replays`(`replayWriter.ts`)へ書き出す
 * 世代ごとのリプレイを、ブラウザで見た目の変化として追えるようにする。
 * - 一覧の各エントリはクリックで即再生。
 * - 「新しい世代を自動再生」がONの間は、manifest.jsonをポーリングして新しいエントリを
 *   検出したら自動的に読み込んで再生する(学習を回しながらタブを開いておくだけで
 *   世代ごとの変化を眺められる)。
 */
export function TrainingReplayPanel({ onLoadReplay }: Props) {
  const [entries, setEntries] = useState<ManifestEntry[]>([])
  const [autoPlay, setAutoPlay] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingFilename, setLoadingFilename] = useState<string | null>(null)
  const lastSeenIterationRef = useRef(-1)

  const loadAndPlay = useCallback(
    async (entry: ManifestEntry) => {
      setLoadingFilename(entry.filename)
      try {
        const res = await fetch(`${REPLAYS_BASE}/${entry.filename}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
        const replay = (await res.json()) as ReplayFile
        lastSeenIterationRef.current = Math.max(lastSeenIterationRef.current, entry.iteration)
        onLoadReplay(replay.seed, replay.simConfig, replay.log)
        setError(null)
      } catch {
        setError(`リプレイの読み込みに失敗しました: ${entry.filename}`)
      } finally {
        setLoadingFilename(null)
      }
    },
    [onLoadReplay],
  )

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`${REPLAYS_BASE}/manifest.json`, { cache: 'no-store' })
        if (!res.ok) return
        const manifest = (await res.json()) as ManifestEntry[]
        if (cancelled) return
        setEntries(manifest)
        setError(null)

        if (autoPlay && manifest.length > 0) {
          const latest = manifest[manifest.length - 1]
          if (latest.iteration > lastSeenIterationRef.current) void loadAndPlay(latest)
        }
      } catch {
        if (!cancelled) setError('学習リプレイ一覧を取得できません(npm run dev / npm run train を確認)')
      }
    }

    void poll()
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [autoPlay, loadAndPlay])

  return (
    <section className="control-panel">
      <h2>学習リプレイ</h2>
      <label>
        新しい世代を自動再生
        <input type="checkbox" checked={autoPlay} onChange={(e) => setAutoPlay(e.target.checked)} />
      </label>
      {error && <p className="mode-indicator">{error}</p>}
      {entries.length === 0 ? (
        <p className="mode-indicator">まだリプレイがありません(npm run train を実行してください)</p>
      ) : (
        <ul className="replay-list">
          {entries
            .slice()
            .reverse()
            .map((entry) => (
              <li key={entry.filename}>
                <button type="button" disabled={loadingFilename === entry.filename} onClick={() => void loadAndPlay(entry)}>
                  世代 {entry.iteration} ({entry.opponentBotKind === 'selfPlay' ? '自己対戦' : `vs ${entry.opponentBotKind}`})
                </button>
              </li>
            ))}
        </ul>
      )}
    </section>
  )
}
