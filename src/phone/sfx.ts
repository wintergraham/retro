import type { ChannelId, Judgement } from '../../shared/protocol'
import { midiToHz } from '../../shared/songs'

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
  private pulse: PeriodicWave | null = null
  private hum: { osc: OscillatorNode; gain: GainNode } | null = null
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
    if (!on) this.humStop()
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
      // 25% duty pulse, the same voice the host uses for the lead.
      const n = 32
      const re = new Float32Array(n)
      const im = new Float32Array(n)
      for (let k = 1; k < n; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25)
      this.pulse = this.ctx.createPeriodicWave(re, im)
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

  /**
   * The note you just hit, played quietly on the phone itself so each player hears their own part
   * in their hand. The host speaker stays the main mix.
   */
  note(midi: number, dur: number) {
    const ctx = this.ctx
    if (!ctx || !this.enabled) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    if (this.pulse) osc.setPeriodicWave(this.pulse)
    else osc.type = 'square'
    osc.frequency.value = midiToHz(midi)
    const len = Math.max(0.08, Math.min(0.45, dur))
    g.gain.setValueAtTime(0.045, t)
    g.gain.setTargetAtTime(0.03, t + 0.02, 0.05)
    g.gain.setTargetAtTime(0.0001, t + len, 0.03)
    osc.connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + len + 0.2)
  }

  /** Kick, snare or tom (pads 0/1/2), as small as the host's but louder than the tick SFX. */
  drum(pad: number) {
    const ctx = this.ctx
    if (!ctx || !this.enabled) return
    const t = ctx.currentTime
    if (pad === 1 && this.noise) {
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 2200
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.09, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09)
      src.connect(f).connect(g).connect(ctx.destination)
      src.start(t)
      src.stop(t + 0.1)
    }
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = pad === 1 ? 'triangle' : 'sine'
    const [from, to, len] = pad === 0 ? [150, 45, 0.14] : pad === 1 ? [260, 180, 0.06] : [220, 120, 0.12]
    osc.frequency.setValueAtTime(from, t)
    osc.frequency.exponentialRampToValueAtTime(to, t + len)
    g.gain.setValueAtTime(pad === 0 ? 0.16 : 0.08, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + len)
    osc.connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + len + 0.01)
  }

  /**
   * Bass phones hum their bassline continuously. `midi` null rests it; `drift` (-1..1, as sent to the
   * host) bends it out of tune the same way the host does, so you hear yourself going sour.
   */
  bassHum(midi: number | null, drift: number) {
    const ctx = this.ctx
    if (!ctx || !this.enabled) return
    if (!this.hum) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      gain.gain.value = 0
      osc.connect(gain).connect(ctx.destination)
      osc.start()
      this.hum = { osc, gain }
    }
    const now = ctx.currentTime
    const off = Math.max(0, Math.abs(drift) - 0.07)
    if (midi != null) this.hum.osc.frequency.setTargetAtTime(midiToHz(midi), now, 0.008)
    this.hum.osc.detune.setTargetAtTime(Math.sign(drift) * Math.min(1000, off * 4000), now, 0.03)
    this.hum.gain.gain.setTargetAtTime(midi == null ? 0 : 0.09, now, midi == null ? 0.02 : 0.01)
  }

  humStop() {
    if (!this.hum || !this.ctx) return
    const { osc, gain } = this.hum
    gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02)
    osc.stop(this.ctx.currentTime + 0.2)
    this.hum = null
  }

  /**
   * Menu sounds, like a handheld's UI: `tap` a plain button, `press` a big round knob, `pick` a channel
   * or arrow, `toggle` a rubber slot button, `back` leaving.
   */
  ui(kind: 'tap' | 'press' | 'pick' | 'toggle' | 'back') {
    const ctx = this.ctx
    if (!ctx || !this.enabled) return
    const t = ctx.currentTime
    if (kind === 'toggle' && this.noise) {
      // Soft rubbery click: a sliver of filtered noise.
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'
      f.frequency.value = 3200
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.08, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.025)
      src.connect(f).connect(g).connect(ctx.destination)
      src.start(t)
      src.stop(t + 0.03)
      return
    }
    if (kind === 'press') {
      // Low thunk that drops, like a rubber dome giving way.
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(420, t)
      osc.frequency.exponentialRampToValueAtTime(160, t + 0.05)
      g.gain.setValueAtTime(0.09, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
      osc.connect(g).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.07)
      return
    }
    if (kind === 'pick') {
      this.tone('square', 880, 0.035, 0.03, t)
      this.tone('square', 1320, 0.05, 0.03, t + 0.04)
      return
    }
    if (kind === 'back') {
      this.tone('square', 660, 0.035, 0.03, t)
      this.tone('square', 440, 0.06, 0.03, t + 0.04)
      return
    }
    this.tone('square', 1568, 0.025, 0.025, t)
  }

  /** Countdown blip; `high` for the final one. */
  blip(high = false) {
    this.tone('square', high ? 1320 : 880, 0.07, 0.03)
  }
}
