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

/** 撃破。 */
export function playKill(): void {
  noiseBurst(0.25, 0.28, 900)
  tone(160, 40, 0.3, 'sawtooth', 0.22)
}

/** リング予告(warnフェーズ開始): ベルを1回鳴らすようなキーンとした音。 */
export function playRingWarn(): void {
  bellTone(1100, 1.1, 0.22)
}

/** リング収縮開始(shrinkフェーズ開始): 警報(サイレン)のように上下する音を数回繰り返す。 */
export function playRingShrink(): void {
  const sweeps = 3
  const sweepDuration = 0.18
  for (let i = 0; i < sweeps; i++) {
    const t = i * sweepDuration * 2
    tone(420, 840, sweepDuration, 'sawtooth', 0.16, t)
    tone(840, 420, sweepDuration, 'sawtooth', 0.16, t + sweepDuration)
  }
}

/** ゲーム終了(勝者確定)。 */
export function playGameOver(): void {
  const notes = [523.25, 659.25, 783.99, 1046.5] // C5 E5 G5 C6
  notes.forEach((freq, i) => tone(freq, freq, 0.25, 'triangle', 0.22, i * 0.14))
}
