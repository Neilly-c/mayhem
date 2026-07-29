import type { SimConfig } from '../sim'

export interface CurriculumStage {
  /** この反復数以上になったら、このステージの`mapRadius`を使う(昇順で並んでいる前提)。 */
  afterIteration: number
  mapRadius: number
}

export function defaultCurriculum(): CurriculumStage[] {
  return [
    { afterIteration: 0, mapRadius: 8 },
    { afterIteration: 50, mapRadius: 15 },
  ]
}

/**
 * `teamCount`/`unitsPerTeam`/`maxVisibleEnemies`/`patchHops`は観測ベクトル長・行動ヘッドの
 * サイズを決めるため学習中は不変(ネットワーク形状が壊れる) — カリキュラムが動かせるのは
 * `mapRadius`だけ。`teamCount:6, unitsPerTeam:3`はここで固定して返す(呼び出し側で
 * 個別に足す必要がないように)。
 */
export function curriculumSimConfig(iteration: number, stages: CurriculumStage[] = defaultCurriculum()): Partial<SimConfig> {
  let mapRadius = stages[0]?.mapRadius ?? 15
  for (const stage of stages) {
    if (iteration >= stage.afterIteration) mapRadius = stage.mapRadius
    else break
  }
  return { mapRadius, teamCount: 6, unitsPerTeam: 3 }
}
