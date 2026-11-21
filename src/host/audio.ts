import type { ChannelId } from '../../shared/protocol'
import { midiToHz, type Chart } from '../../shared/songs'

/** Fourier coefficients for an NES-style pulse wave with the given duty cycle. */
function pulseWave(ctx: AudioContext, duty: number): PeriodicWave {
  const n = 64
  const real = new Float32Array(n)
  const imag = new Float32Array(n)
  for (let k = 1; k < n; k++) {
    real[k] = Math.sin(2 * Math.PI * k * duty) / (Math.PI * k)
    imag[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (Math.PI * k)
  }
  return ctx.createPeriodicWave(real, imag)
}

interface Channel {
  gain: GainNode
  analyser: AnalyserNode
}

/**
 * Four-channel chip synth that plays a chart in sync with a shared start time.
 * Missed notes duck the matching channel; the bass player's tilt bends the triangle.
 */
export class ChipSynth {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' })
  readonly channels: Record<ChannelId, Channel>
  private master: GainNode
  private noise: AudioBuffer
  private pulse25: PeriodicWave
  private pulse12: PeriodicWave
  private timer = 0
  private bend = 0
  private liveBass = new Set<OscillatorNode>()
  private live = new Set<AudioScheduledSourceNode>()
  /** AudioContext time of the song's first downbeat (as heard). */
  songStart = 0
  /** Manual nudge (seconds) for speakers whose delay the browser doesn't report, e.g. Bluetooth or TV. */
  extraLatency = 0

  constructor() {
    const ctx = this.ctx
    const comp = ctx.createDynamicsCompressor()
    comp.connect(ctx.destination)
    this.master = ctx.createGain()
    this.master.gain.value = 0.8
    this.master.connect(comp)
    const make = (): Channel => {
      const gain = ctx.createGain()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      gain.connect(analyser).connect(this.master)
      return { gain, analyser }
    }
    this.channels = { lead: make(), bass: make(), drums: make(), arp: make() }
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.pulse25 = pulseWave(ctx, 0.25)
    this.pulse12 = pulseWave(ctx, 0.125)
  }

  /** Seconds of output latency we compensate for, so what's heard lines up with the phones. */
  get latency() {
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) + this.extraLatency
  }

  /** Song time (seconds) as currently heard through the speakers. */
  songTime() {
    return this.ctx.currentTime - this.latency - this.songStart
  }

  play(chart: Chart, secondsUntilStart: number) {
    this.stop()
    const now = this.ctx.currentTime
    this.songStart = now + secondsUntilStart - this.latency
    for (const ch of Object.values(this.channels)) {
      ch.gain.gain.cancelScheduledValues(now)
      ch.gain.gain.setValueAtTime(1, now)
    }
    this.setBend(0)

    // Countdown blips on the last three beats-ish of the lead-in.
    for (let i = 3; i >= 1; i--) this.blip(i === 1 ? 1320 : 880, this.songStart - i * chart.beat, 0.08)

    const idx = { lead: 0, bass: 0, arp: 0, drums: 0, hats: 0 }
    const tick = () => {
      const horizon = this.ctx.currentTime + 0.2 - this.songStart
      while (idx.lead < chart.lead.length && chart.lead[idx.lead].t < horizon) this.tone('lead', chart.lead[idx.lead++])
      while (idx.bass < chart.bass.length && chart.bass[idx.bass].t < horizon) this.tone('bass', chart.bass[idx.bass++])
      while (idx.arp < chart.arp.length && chart.arp[idx.arp].t < horizon) this.tone('arp', chart.arp[idx.arp++])
      while (idx.drums < chart.drums.length && chart.drums[idx.drums].t < horizon) {
        const h = chart.drums[idx.drums++]
        this.drum(h.pad, this.songStart + h.t)
      }
      while (idx.hats < chart.hats.length && chart.hats[idx.hats] < horizon) this.hat(this.songStart + chart.hats[idx.hats++])
    }
    tick()
    this.timer = window.setInterval(tick, 25)
  }

  stop() {
    clearInterval(this.timer)
    const now = this.ctx.currentTime
    for (const src of this.live) {
      try {
        src.stop(now + 0.02)
      } catch {}
    }
    this.live.clear()
    this.liveBass.clear()
  }

  /** Remember a scheduled source so stop() can cut it. */
  private track(src: AudioScheduledSourceNode) {
    this.live.add(src)
    src.addEventListener('ended', () => this.live.delete(src))
  }

  /** Briefly drop a channel out, like a dead cartridge contact. */
  dropout(ch: ChannelId, seconds: number) {
    const g = this.channels[ch].gain.gain
    const now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setTargetAtTime(0.08, now, 0.01)
    g.setTargetAtTime(1, now + seconds, 0.03)
  }

  setBend(cents: number) {
    this.bend = cents
    const now = this.ctx.currentTime
    for (const osc of this.liveBass) osc.detune.setTargetAtTime(cents, now, 0.03)
  }

  gameOver() {
    this.stop()
    const t = this.ctx.currentTime + 0.1
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.setPeriodicWave(this.pulse25)
    osc.frequency.setValueAtTime(660, t)
    osc.frequency.exponentialRampToValueAtTime(55, t + 1.4)
    g.gain.setValueAtTime(0.25, t)
    g.gain.linearRampToValueAtTime(0, t + 1.5)
    osc.connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + 1.6)
  }

  fanfare() {
    const t = this.ctx.currentTime + 0.05
    ;[72, 76, 79, 84, 79, 84].forEach((m, i) => this.blip(midiToHz(m), t + i * 0.1, i === 5 ? 0.5 : 0.09))
  }

  /** Calibration clicks, timed so they're heard `secondsUntil` from now and every `interval` after. */
  clicks(secondsUntil: number, count: number, interval: number) {
    const first = this.ctx.currentTime + secondsUntil - this.latency
    for (let i = 0; i < count; i++) this.blip(1760, first + i * interval, 0.03)
  }

  blip(freq: number, when: number, dur: number) {
    if (when < this.ctx.currentTime) return
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.setPeriodicWave(this.pulse25)
    osc.frequency.value = freq
    g.gain.setValueAtTime(0.15, when)
    g.gain.setValueAtTime(0, when + dur)
    osc.connect(g).connect(this.master)
    osc.start(when)
    osc.stop(when + dur + 0.02)
  }

  private tone(ch: 'lead' | 'bass' | 'arp', n: { t: number; d: number; midi: number }) {
    const t = this.songStart + n.t
    if (t < this.ctx.currentTime - 0.05) return
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    const vol = ch === 'lead' ? 0.16 : ch === 'bass' ? 0.42 : 0.06
    if (ch === 'bass') {
      osc.type = 'triangle'
      osc.detune.value = this.bend
      this.liveBass.add(osc)
      osc.addEventListener('ended', () => this.liveBass.delete(osc))
    } else {
      osc.setPeriodicWave(ch === 'lead' ? this.pulse25 : this.pulse12)
    }
    osc.frequency.value = midiToHz(n.midi)
    const end = t + Math.max(0.05, n.d * (ch === 'lead' ? 0.92 : 1))
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.004)
    if (ch === 'lead') g.gain.setTargetAtTime(vol * 0.7, t + 0.05, 0.1)
    g.gain.setTargetAtTime(0, end - 0.015, 0.005)
    osc.connect(g).connect(this.channels[ch].gain)
    this.track(osc)
    osc.start(t)
    osc.stop(end + 0.01)
  }

  private noiseBurst(when: number, filter: BiquadFilterType, freq: number, vol: number, decay: number) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const f = this.ctx.createBiquadFilter()
    f.type = filter
    f.frequency.value = freq
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, when)
    g.gain.exponentialRampToValueAtTime(0.001, when + decay)
    src.connect(f).connect(g).connect(this.channels.drums.gain)
    this.track(src)
    src.start(when, Math.random() * 0.5)
    src.stop(when + decay + 0.02)
  }

  private thump(when: number, from: number, to: number, vol: number, decay: number) {
    const osc = this.ctx.createOscillator()
    osc.type = 'triangle'
    const g = this.ctx.createGain()
    osc.frequency.setValueAtTime(from, when)
    osc.frequency.exponentialRampToValueAtTime(to, when + decay)
    g.gain.setValueAtTime(vol, when)
    g.gain.exponentialRampToValueAtTime(0.001, when + decay)
    osc.connect(g).connect(this.channels.drums.gain)
    this.track(osc)
    osc.start(when)
    osc.stop(when + decay + 0.02)
  }

  private drum(pad: number, when: number) {
    if (when < this.ctx.currentTime - 0.05) return
    if (pad === 0) {
      this.thump(when, 180, 40, 0.9, 0.16)
      this.noiseBurst(when, 'lowpass', 1200, 0.15, 0.03)
    } else if (pad === 1) {
      this.noiseBurst(when, 'bandpass', 2000, 0.6, 0.16)
      this.thump(when, 240, 160, 0.3, 0.06)
    } else {
      this.thump(when, 260, 90, 0.6, 0.2)
    }
  }

  private hat(when: number) {
    if (when < this.ctx.currentTime - 0.05) return
    this.noiseBurst(when, 'highpass', 7000, 0.12, 0.035)
  }
}
