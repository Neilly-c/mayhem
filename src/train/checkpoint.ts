import * as fs from 'node:fs'
import * as path from 'node:path'
import { ActorCriticModel } from './network'
import type { CheckpointMeta } from './types'

/** `model.save`(重み本体)に加えて、TF.js自身の`model.json`には乗らない学習メタ情報
 * (`NetworkConfig`/`SimConfig`/反復数)を`meta.json`サイドカーとして書き出す。 */
export async function saveCheckpoint(model: ActorCriticModel, dir: string, meta: CheckpointMeta): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  await model.save(dir)
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
}

export async function loadCheckpoint(dir: string): Promise<{ model: ActorCriticModel; meta: CheckpointMeta }> {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) as CheckpointMeta
  const model = await ActorCriticModel.load(dir, meta.networkConfig)
  return { model, meta }
}
