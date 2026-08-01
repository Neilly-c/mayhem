/**
 * ユーザー要望: SEを追加する。音声ファイルを用意する代わりに、Web Audio APIでその場合成する
 * 軽量なSEエンジン(依存追加・アセット管理が不要)。ブラウザの自動再生ポリシー対策として
 * `AudioContext`は初回の(通常はボタンclickなどユーザー操作起点の)呼び出しで遅延生成し、
 * 以後は使い回す。
 */

let ctx: AudioContext | null = null
let masterGain: GainNode | null = null
let muted = false

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext
  if (!Ctor) return null
  if (!ctx) {
    ctx = new Ctor()
    masterGain = ctx.createGain()
    masterGain.gain.value = 0.35
    masterGain.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export function setMuted(next: boolean): void {
  muted = next
}

export function isMuted(): boolean {
  return muted
}

function tone(
  freqStart: number,
  freqEnd: number,
  duration: number,
  type: OscillatorType,
  gainPeak: number,
  delay = 0,
): void {
  const audio = getContext()
  if (!audio || !masterGain || muted) return
  const t0 = audio.currentTime + delay
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freqStart, t0)
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + duration)
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
  osc.connect(gain)
  gain.connect(masterGain)
  osc.start(t0)
  osc.stop(t0 + duration + 0.02)
}

/** ベル的な金属音: 非整数倍音(基音+2.4倍音+3.76倍音)を重ね、指数的にゆっくり減衰させることで
 * 単発の打鍵でも「キーン」と響く感じを出す(単純なsine1本だとただのビープ音になってしまう)。 */
function bellTone(freq: number, duration: number, gainPeak: number, delay = 0): void {
  const audio = getContext()
  if (!audio || !masterGain || muted) return
  const master = masterGain
  const t0 = audio.currentTime + delay
  const partials = [1, 2.4, 3.76]
  partials.forEach((mult, i) => {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq * mult, t0)
    const peak = gainPeak / (i + 1)
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    osc.connect(gain)
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + duration + 0.02)
  })
}

function noiseBurst(duration: number, gainPeak: number, filterFreq: number, delay = 0): void {
  const audio = getContext()
  if (!audio || !masterGain || muted) return
  const t0 = audio.currentTime + delay
  const bufferSize = Math.max(1, Math.floor(audio.sampleRate * duration))
  const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1

  const noise = audio.createBufferSource()
  noise.buffer = buffer
  const filter = audio.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(filterFreq, t0)
  const gain = audio.createGain()
  gain.gain.setValueAtTime(gainPeak, t0)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)

  noise.connect(filter)
  filter.connect(gain)
  gain.connect(masterGain)
  noise.start(t0)
  noise.stop(t0 + duration + 0.02)
}

/** ボタンhover: ごく短く控えめなクリック音より軽いブリップ。 */
export function playHover(): void {
  tone(700, 900, 0.045, 'sine', 0.06)
}

/** ボタンclick。 */
export function playClick(): void {
  tone(520, 320, 0.08, 'square', 0.15)
}

/** ユニット選択。 */
export function playSelect(): void {
  tone(600, 1000, 0.07, 'triangle', 0.18)
}

/** 攻撃命中。tickごとに大量に鳴り得るため、他のSEより控えめな音量にする。 */
export function playHit(): void {
  noiseBurst(0.06, 0.08, 1800)
  tone(220, 120, 0.06, 'square', 0.05)
}

/** ユーザー要望: チェインダメージが1体以上の敵に成功した際、通常の`playHit`とは違うSEを鳴らす
 * (どの攻撃が連鎖したのか耳で分かるように)。`playHit`が単発のノイズ+低音1つなのに対し、
 * 短い間隔で3回弾ける「バチバチバチ」という電撃的な連打にして「複数箇所に波及した」感を出す。 */
export function playChainHit(): void {
  const pulses = 3
  const interval = 0.045
  for (let i = 0; i < pulses; i++) {
    const t = i * interval
    noiseBurst(0.035, 0.09, 3400, t)
    tone(900 - i * 120, 500 - i * 80, 0.04, 'square', 0.07, t)
  }
}

/** 撃破。 */
export function playKill(): void {
  noiseBurst(0.25, 0.28, 900)
  tone(160, 40, 0.3, 'sawtooth', 0.22)
}

/** リング予告(warnフェーズ開始): ベルを1回鳴らすようなキーンとした音。ユーザー要望でより高音に。 */
export function playRingWarn(): void {
  bellTone(1500, 1.1, 0.22)
}

/** リング収縮開始(shrinkフェーズ開始): ユーザー要望でコミカルなパトカーのサイレン風に
 * (「ウーウー」と高低を素早く往復)。従来のsawtoothは音が鋭すぎたため、丸みのあるtriangle波に
 * 変更しつつ、往復のテンポを少し速めて玩具っぽい賑やかさを出す。 */
export function playRingShrink(): void {
  const cycles = 4
  const cycleDuration = 0.16
  for (let i = 0; i < cycles; i++) {
    const t = i * cycleDuration * 2
    tone(520, 980, cycleDuration, 'triangle', 0.2, t)
    tone(980, 520, cycleDuration, 'triangle', 0.2, t + cycleDuration)
  }
}

/** ゲーム終了(勝者確定)。 */
export function playGameOver(): void {
  const notes = [523.25, 659.25, 783.99, 1046.5] // C5 E5 G5 C6
  notes.forEach((freq, i) => tone(freq, freq, 0.25, 'triangle', 0.22, i * 0.14))
}

/** ユーザー要望: アビリティ発動ごとに専用のSEを鳴らす。同一tickに同種のアビリティが複数
 * 発動しても呼び出し側(§useSimulationLoop.ts)が種類ごとに1回だけ呼ぶので、ここでは
 * 単発の音だけを定義すればよい。 */

/** ペイントボール発射: 短い「ポン」という空気音+低いポップ音。 */
export function playPaintball(): void {
  noiseBurst(0.05, 0.1, 2600)
  tone(300, 180, 0.09, 'sine', 0.14)
}

/** ユーザー要望: ペイントボール着弾時のスプラッシュ音。発射音(`playPaintball`、短く軽いポン音)
 * とは別の、着弾の瞬間だけに鳴る音 — 広がる塗料をイメージした、低域中心のこもったノイズバースト
 * (発射音より低いフィルタ周波数・長めの減衰)に、水っぽい下降トーンを重ねる。 */
export function playPaintballSplash(): void {
  noiseBurst(0.16, 0.16, 900)
  tone(500, 140, 0.14, 'sine', 0.12, 0.01)
}

/** レーザー発射: 鋭く下降するsawtoothのビーム音。 */
export function playLaser(): void {
  tone(2200, 400, 0.14, 'sawtooth', 0.16)
}

/** ダメージシールド発動: ベルの上昇するシマー音(防御の張り感)。 */
export function playDamageShield(): void {
  bellTone(700, 0.4, 0.16)
  tone(500, 900, 0.2, 'sine', 0.1)
}

/** スピードブースト発動: 素早く上昇するホイッスル音。 */
export function playSpeedBoost(): void {
  tone(500, 1600, 0.18, 'triangle', 0.16)
}

/** 連鎖ダメージ有効化: バチバチと弾ける電気的なノイズ+低いうなり。 */
export function playChainDamage(): void {
  noiseBurst(0.12, 0.14, 3200)
  tone(150, 90, 0.22, 'square', 0.12)
}
