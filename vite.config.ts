import * as fs from 'node:fs'
import * as path from 'node:path'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

const CHECKPOINT_DIR_PATTERN = /^(py-)?iter-\d+$/
const CHECKPOINTS_ROOT = path.resolve(__dirname, 'checkpoints')

interface CheckpointManifestEntry {
  dir: string
  iteration: number
  score: number | null
  createdAt: string
}

function listCheckpointDirs(): CheckpointManifestEntry[] {
  if (!fs.existsSync(CHECKPOINTS_ROOT)) return []
  const entries: CheckpointManifestEntry[] = []
  for (const name of fs.readdirSync(CHECKPOINTS_ROOT)) {
    if (!CHECKPOINT_DIR_PATTERN.test(name)) continue
    const metaPath = path.join(CHECKPOINTS_ROOT, name, 'meta.json')
    if (!fs.existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
        iteration: number
        score?: number | null
        createdAt: string
      }
      entries.push({ dir: name, iteration: meta.iteration, score: meta.score ?? null, createdAt: meta.createdAt })
    } catch {
      // Skip a checkpoint whose meta.json is still being written (mid-save race) rather than
      // crash the dev server on a transient JSON parse error.
    }
  }
  return entries
}

/**
 * ユーザー要望: ブラウザから学習中のチェックポイント(`checkpoints/` — `public/`配下ではないため
 * 通常はViteが配信しない)を読み込めるようにする開発サーバー専用ルート。npm run dev限定
 * (npm run buildの本番出力には一切含めない — checkpointsディレクトリはgitignore対象かつ
 * 環境依存の学習成果物なので、本番ビルドに焼き込む対象ではない)。
 *
 * - `GET /checkpoints/manifest.json` -> 発見したチェックポイント一覧。TS学習(`iter-N`)と
 *   Python学習(`py-iter-N`)を区別せずまとめて対象にする(TF.js形式で相互互換のため)。
 * - `GET /checkpoints/<dir>/(model.json|weights.bin)` -> 該当ファイルをそのまま返す。
 *   `tf.loadLayersModel`のブラウザ標準HTTP IOHandlerがそのままfetchできる形。
 */
function checkpointsDevMiddleware(): Plugin {
  return {
    name: 'mayhem-checkpoints-dev-middleware',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/checkpoints', (req, res, next) => {
        if (!req.url) return next()
        if (req.url === '/manifest.json') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(listCheckpointDirs()))
          return
        }

        const relative = decodeURIComponent(req.url.replace(/^\/+/, ''))
        const filePath = path.join(CHECKPOINTS_ROOT, relative)
        // Guard against path traversal (`..` segments escaping CHECKPOINTS_ROOT) before touching the filesystem.
        if (!filePath.startsWith(CHECKPOINTS_ROOT + path.sep)) return next()
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next()

        res.setHeader('Content-Type', filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream')
        fs.createReadStream(filePath).pipe(res)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), checkpointsDevMiddleware()],
})
