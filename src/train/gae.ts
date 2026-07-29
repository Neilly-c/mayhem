/**
 * Generalized Advantage Estimation。純粋な数値計算のみでTF.jsに依存しない
 * (rolloutBuffer.ts側でtensorをJS配列へ落としてから渡す)。
 *
 * 1セグメント = 1ユニットの「1ライフ」(ロールアウト内で連続した生存区間)。死ぬのは区間の
 * 最後だけなので、セグメント内部にステップごとの`done`配列は不要 — 最後のステップが本当の死
 * (`terminal: true`、ブートストラップ0)か、打ち切り/ロールアウト長到達での継続中(`terminal: false`、
 * 追加の1回だけの価値関数フォワードパスで得た`bootstrapValue`を使う)かだけを区別すればよい。
 */
export interface GaeSegment {
  /** 各意思決定ステップの報酬。長さT。 */
  rewards: number[]
  /** 各意思決定ステップでの価値関数推定 V(s_t)。`rewards`と同じ長さT。 */
  values: number[]
  /** V(s_T)。`terminal`がtrueのときは無視され0として扱う。 */
  bootstrapValue: number
  /** 本当に死んだ(Envの`terminations[unitId]`)か。打ち切り(truncation)やロールアウト長での
   * 途中終了なら false。 */
  terminal: boolean
}

export interface GaeResult {
  advantages: number[]
  returns: number[]
}

export function computeGAE(segment: GaeSegment, gamma: number, lambda: number): GaeResult {
  const { rewards, values, bootstrapValue, terminal } = segment
  const T = rewards.length
  const advantages = new Array<number>(T)
  const returns = new Array<number>(T)

  const vLast = terminal ? 0 : bootstrapValue
  let gae = 0
  for (let t = T - 1; t >= 0; t--) {
    const vNext = t === T - 1 ? vLast : values[t + 1]
    const delta = rewards[t] + gamma * vNext - values[t]
    gae = delta + gamma * lambda * gae
    advantages[t] = gae
    returns[t] = gae + values[t]
  }

  return { advantages, returns }
}
