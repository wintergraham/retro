import type { ChannelId, Judgement } from '../../shared/protocol'

const KEY = 'chip-squad:sfx'
const TICK: Record<ChannelId, { type: OscillatorType; hz: number }> = {
  lead: { type: 'square', hz: 1046 },
  bass: { type: 'triangle', hz: 330 },
  drums: { type: 'square', hz: 523 },
}

/** Tiny, quiet chip SFX on the phone itself so taps feel answered without fighting the host speaker. */
export class PhoneSfx {
  private ctx: AudioContext | null = null
  private noise: AudioBuffer | null = null
  enabled: boolean

  constructor() {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(KEY)
    } catch {}
    this.enabled = saved !== 'off'
  }

  setEnabled(on: boolean) {
    this.enabled = on
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off')
    } catch {}
  }

  /** Call from a user gesture (the JOIN tap) so iOS lets the context run. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.ctx = new Ctor({ latencyHint: 'interactive' })
      this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate / 10, this.ctx.sampleRate)
      const d = this.noise.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
      // A silent buffer played inside the gesture is what actually unlocks iOS.
      const src = this.ctx.createBufferSource()
      src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      src.connect(this.ctx.destination)
      src.start()
    }
    void this.ctx.resume()
  }

  private tone(type: OscillatorType, hz: number, dur: number, vol: number, when = 0) {
    const ctx = this.ctx
    if (!ctx || !this.enabled) return
    const t = Math.max(ctx.currentTime, when)
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.value = hz
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + dur + 0.01)
  }

  judge(channel: ChannelId, r: Judgement) {
    if (r === 'miss') return this.miss()
    const { type, hz } = TICK[channel]
    this.tone(type, r === 'perfect' ? hz * 1.12 : hz, 0.04, 0.035)
  }

  miss() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || !this.noise) return
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(1800, t)
    f.frequency.exponentialRampToValueAtTime(200, t + 0.09)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.06, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
    src.connect(f).connect(g).connect(ctx.destination)
    src.start(t)
    src.stop(t + 0.11)
  }

  /** Countdown blip; `high` for the final one. */
  blip(high = false) {
    this.tone('square', high ? 1320 : 880, 0.07, 0.03)
  }
}
