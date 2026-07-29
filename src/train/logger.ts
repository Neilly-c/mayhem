import * as fs from 'node:fs'

export interface Logger {
  log(event: Record<string, unknown>): void
}

/** 標準出力への1行JSON出力 + 任意でJSONL(1行1JSON)ファイルへの追記。TensorBoard等は使わない
 * (§11.6のスコープ外、新規依存を増やさない)。 */
export function createLogger(logPath?: string): Logger {
  return {
    log(event: Record<string, unknown>) {
      const line = JSON.stringify({ time: new Date().toISOString(), ...event })
      console.log(line)
      if (logPath) fs.appendFileSync(logPath, line + '\n')
    },
  }
}
