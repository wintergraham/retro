import type { ChannelId, VoiceId } from '../../shared/protocol'
import { midiToHz, type Chart } from '../../shared/songs'

/** Fourier coefficients for an NES-style pulse wave with the given duty cycle. */
function pulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  const n = 64
  const real = new Float32Array(n)
  const imag = new Float32Array(n)
  for (let k = 1; k < n; k++) {
    real[k] = Math.sin(2 * Math.PI * k * duty) / (Math.PI * k)
    imag[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (Math.PI * k)
  }
  return ctx.createPeriodicWave(real, imag)
}

/** Hard-clipped staircase: a WaveShaper stand-in for a bitcrusher. */
function crushCurve(levels: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(4096)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.round(x * levels) / levels
  }
  return curve
}

function driveCurve(k: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(2048)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / Math.tanh(k)
  }
  return curve
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)

/**
 * Drop everything scheduled from `now` on. cancelScheduledValues alone can't cut short a value curve
 * that's already running (and scheduling over one throws), so prefer cancelAndHoldAtTime where it exists.
 */
function clear(p: AudioParam, now: number) {
  const hold = (p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }).cancelAndHoldAtTime
  if (hold) hold.call(p, now)
  else p.cancelScheduledValues(now)
}

interface Channel {
  /** Voices connect here. */
  input: GainNode
  dry: GainNode
  /** Level of the bitcrushed copy of the channel. */
  wet: GainNode
  /** Stutter / cut gate. */
  gate: GainNode
  gain: GainNode
  analyser: AnalyserNode
  /** Cents offset for a sour miss bend. */
  sour: ConstantSourceNode
  /** Sums every pitch modulator; each voice's detune listens to it. */
  pitch: GainNode
}

// Voice levels, and how hard each channel is pushed into its crusher so quiet channels still crunch.
const CRUSH_DRIVE: Record<VoiceId, number> = { lead: 4, bass: 2, drums: 1.3, arp: 10 }

// How each channel tends to fall apart on a miss (probabilities).
const MISS_STYLE: Record<ChannelId, { sour: number; stutter: number; cut: number; crush: number }> = {
  lead: { sour: 0.95, stutter: 0.75, cut: 0.15, crush: 0.6 },
  drums: { sour: 0.15, stutter: 0.35, cut: 0.9, crush: 0.5 },
  bass: { sour: 0.9, stutter: 0.3, cut: 0.15, crush: 0.7 },
}

/**
 * Four-voice chip synth (lead, bass, drums for players; arp is CPU backing) that plays a chart in sync with a shared start time.
 * Misses sour, stutter and crush the matching channel, the bass player's drift bends the triangle,
 * and the whole mix degrades (drive, crush, closing lowpass, warble, dropouts) as team health falls.
 */
export class ChipSynth {
  readonly ctx: AudioContext
  readonly channels: Record<VoiceId, Channel>
  private master: GainNode
  private noise: AudioBuffer
  private pulse25: PeriodicWave
  private pulse12: PeriodicWave
  private chCrush = crushCurve(4)
  private timer = 0
  private live = new Set<AudioScheduledSourceNode>()
  // Bass drift
  private bend: ConstantSourceNode
  private vibDepth: GainNode
  // Health degradation
  private mDry: GainNode
  private driveWet: GainNode
  private crushWet: GainNode
  private lowpass: BiquadFilterNode
  private micro: GainNode
  private warbleDepth: GainNode
  private flutterDepth: GainNode
  private damage = 0
  private lastHealthAt = 0
  /** AudioContext time of the song's first downbeat (as heard). */
  songStart = 0
  /** Manual nudge (seconds) for speakers whose delay the browser doesn't report, e.g. Bluetooth or TV. */
  extraLatency = 0

  /** Pass an OfflineAudioContext to render offline (tests); defaults to a live, low-latency context. */
  constructor(ctx?: BaseAudioContext) {
    this.ctx = (ctx ?? new AudioContext({ latencyHint: 'interactive' })) as AudioContext
    const c = this.ctx
    const comp = c.createDynamicsCompressor()
    comp.connect(c.destination)

    // Master: dry + overdrive + bitcrush paths -> closing lowpass -> micro-dropout gate.
    this.master = c.createGain()
    this.master.gain.value = 0.8
    this.micro = c.createGain()
    this.micro.connect(comp)
    this.lowpass = c.createBiquadFilter()
    this.lowpass.type = 'lowpass'
    this.lowpass.frequency.value = 20000
    this.lowpass.Q.value = 0.707
    this.lowpass.connect(this.micro)
    this.mDry = c.createGain()
    this.master.connect(this.mDry).connect(this.lowpass)
    const drivePre = c.createGain()
    drivePre.gain.value = 2
    const drive = c.createWaveShaper()
    drive.curve = driveCurve(4)
    drive.oversample = '2x'
    this.driveWet = c.createGain()
    this.driveWet.gain.value = 0
    this.master.connect(drivePre).connect(drive).connect(this.driveWet).connect(this.lowpass)
    const crushPre = c.createGain()
    crushPre.gain.value = 1.6
    const crush = c.createWaveShaper()
    crush.curve = crushCurve(6)
    this.crushWet = c.createGain()
    this.crushWet.gain.value = 0
    this.master.connect(crushPre).connect(crush).connect(this.crushWet).connect(this.lowpass)

    // Tape warble: slow wow + fast flutter, both silent until health drops.
    const lfo = (hz: number) => {
      const o = c.createOscillator()
      o.frequency.value = hz
      o.start()
      return o
    }
    this.warbleDepth = c.createGain()
    this.warbleDepth.gain.value = 0
    this.flutterDepth = c.createGain()
    this.flutterDepth.gain.value = 0
    lfo(0.7).connect(this.warbleDepth)
    lfo(7.3).connect(this.flutterDepth)

    const make = (id: VoiceId): Channel => {
      const input = c.createGain()
      const dry = c.createGain()
      const pre = c.createGain()
      pre.gain.value = CRUSH_DRIVE[id]
      const shaper = c.createWaveShaper()
      shaper.curve = this.chCrush
      const wet = c.createGain()
      wet.gain.value = 0
      const gate = c.createGain()
      const gain = c.createGain()
      const analyser = c.createAnalyser()
      analyser.fftSize = 1024
      input.connect(dry).connect(gate)
      input.connect(pre).connect(shaper).connect(wet).connect(gate)
      gate.connect(gain).connect(analyser).connect(this.master)
      const sour = c.createConstantSource()
      sour.offset.value = 0
      sour.start()
      const pitch = c.createGain()
      sour.connect(pitch)
      this.warbleDepth.connect(pitch)
      this.flutterDepth.connect(pitch)
      return { input, dry, wet, gate, gain, analyser, sour, pitch }
    }
    this.channels = { lead: make('lead'), bass: make('bass'), drums: make('drums'), arp: make('arp') }

    this.bend = c.createConstantSource()
    this.bend.offset.value = 0
    this.bend.start()
    this.bend.connect(this.channels.bass.pitch)
    this.vibDepth = c.createGain()
    this.vibDepth.gain.value = 0
    lfo(6).connect(this.vibDepth).connect(this.channels.bass.pitch)

    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.pulse25 = pulseWave(c, 0.25)
    this.pulse12 = pulseWave(c, 0.125)
  }

  /** Seconds of output latency we compensate for, so what's heard lines up with the phones. */
  get latency() {
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) + this.extraLatency
  }

  /** Song time (seconds) as currently heard through the speakers. */
  songTime() {
    return this.ctx.currentTime - this.latency - this.songStart
  }

  /** `lookahead` is how far ahead notes get scheduled; offline renders pass the whole song. */
  play(chart: Chart, secondsUntilStart: number, lookahead = 0.2) {
    this.stop()
    const now = this.ctx.currentTime
    this.songStart = now + secondsUntilStart - this.latency
    for (const ch of Object.values(this.channels)) {
      for (const p of [ch.gain.gain, ch.gate.gain, ch.dry.gain, ch.wet.gain, ch.sour.offset]) clear(p, now)
      ch.gain.gain.setValueAtTime(1, now)
      ch.gate.gain.setValueAtTime(1, now)
      ch.dry.gain.setValueAtTime(1, now)
      ch.wet.gain.setValueAtTime(0, now)
      ch.sour.offset.setValueAtTime(0, now)
    }
    this.bassDrift(0)
    this.setHealth(100, true)

    // Countdown blips on the last three beats-ish of the lead-in.
    for (let i = 3; i >= 1; i--) this.blip(i === 1 ? 1320 : 880, this.songStart - i * chart.beat, 0.08)

    const idx = { lead: 0, bass: 0, arp: 0, drums: 0, hats: 0 }
    const tick = () => {
      const horizon = this.ctx.currentTime + lookahead - this.songStart
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
  }

  /** Remember a scheduled source so stop() can cut it, and hook it to its channel's pitch bus. */
  private track(src: AudioScheduledSourceNode & { detune: AudioParam }, ch: VoiceId) {
    const pitch = this.channels[ch].pitch
    pitch.connect(src.detune)
    this.live.add(src)
    src.addEventListener('ended', () => {
      this.live.delete(src)
      try {
        pitch.disconnect(src.detune)
      } catch {}
    })
  }

  /**
   * A missed note, made audible: the channel goes sour, stutters or cuts out, and crunches through
   * its bitcrusher for about a beat. The mix of effects is rolled per miss so it never repeats exactly.
   */
  miss(ch: ChannelId, beat: number) {
    const c = this.channels[ch]
    const style = MISS_STYLE[ch]
    const now = this.ctx.currentTime
    const dur = beat * rand(0.85, 1.25)
    let fx = 0

    const sour = Math.random() < style.sour
    const gate = Math.random() < style.cut ? 'cut' : Math.random() < style.stutter ? 'stutter' : null
    const crush = Math.random() < style.crush
    fx = +sour + +!!gate + +crush
    // Always at least two effects so a miss can't slip by unnoticed.
    if (fx < 2) {
      if (!sour && ch !== 'drums') this.sourBend(c, now, dur)
      else this.gate(c, now, dur, ch === 'drums' ? 'cut' : 'stutter', beat)
    }
    if (sour) this.sourBend(c, now, dur)
    if (gate) this.gate(c, now, dur, gate, beat)
    if (crush || fx < 2) {
      for (const [p, v] of [[c.wet.gain, 1], [c.dry.gain, 0.25]] as const) {
        clear(p, now)
        p.setTargetAtTime(v, now, 0.004)
        p.setTargetAtTime(v === 1 ? 0 : 1, now + dur, 0.02)
      }
    }
    this.crunch(ch, now)
  }

  private sourBend(c: Channel, now: number, dur: number) {
    const cents = rand(60, 150) * (Math.random() < 0.5 ? -1 : 1)
    const wobble = rand(15, 40)
    const hz = rand(5, 11)
    const curve = new Float32Array(96)
    const start = c.sour.offset.value
    for (let i = 0; i < curve.length; i++) {
      const k = i / (curve.length - 1)
      const env = Math.min(1, k * 12) * Math.min(1, (1 - k) * 4)
      curve[i] = start * (1 - Math.min(1, k * 12)) + env * (cents + wobble * Math.sin(2 * Math.PI * hz * k * dur))
    }
    curve[curve.length - 1] = 0
    clear(c.sour.offset, now)
    try {
      c.sour.offset.setValueCurveAtTime(curve, now, dur)
    } catch {
      // Still inside the previous sour curve on a browser without cancelAndHoldAtTime: that one keeps going.
    }
  }

  private gate(c: Channel, now: number, dur: number, kind: 'cut' | 'stutter', beat: number) {
    const g = c.gate.gain
    clear(g, now)
    if (kind === 'cut') {
      g.setTargetAtTime(0, now, 0.004)
    } else {
      // 32nd-note chop by default, sometimes 16th triplets or 16ths, with an uneven duty.
      const step = beat / [8, 8, 6, 4][Math.floor(Math.random() * 4)]
      const duty = rand(0.3, 0.6)
      for (let t = 0; t < dur; t += step) {
        g.setTargetAtTime(0, now + t + step * duty, 0.002)
        g.setTargetAtTime(1, now + t + step, 0.002)
      }
    }
    g.setTargetAtTime(1, now + dur, 0.006)
  }

  /** Short bitcrushed noise crunch on the channel, after the gate so a cut still crunches. */
  private crunch(ch: ChannelId, now: number) {
    const c = this.ctx
    const src = c.createBufferSource()
    src.buffer = this.noise
    src.playbackRate.value = rand(0.15, 0.4)
    const f = c.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = rand(500, 1600)
    f.Q.value = 2
    const pre = c.createGain()
    pre.gain.value = 3
    const shaper = c.createWaveShaper()
    shaper.curve = this.chCrush
    const g = c.createGain()
    g.gain.setValueAtTime(0.18, now)
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.14)
    src.connect(f).connect(pre).connect(shaper).connect(g).connect(this.channels[ch].gain)
    src.start(now, Math.random() * 0.5)
    src.stop(now + 0.16)
  }

  /** Bass player's distance from the track (0..1 screen widths). Small drift is forgiven; past that it bends hard and wobbles. */
  bassDrift(v: number) {
    const off = Math.max(0, Math.abs(v) - 0.07)
    const now = this.ctx.currentTime
    this.bend.offset.setTargetAtTime(Math.sign(v) * Math.min(1000, off * 4000), now, 0.03)
    this.vibDepth.gain.setTargetAtTime(Math.min(90, off * 600), now, 0.05)
  }

  /**
   * Team health -> how broken the cartridge sounds. Clean at 90+, then drive, crush, a closing
   * resonant lowpass and tape warble ramp in; under 30 HP it also drops out for split seconds.
   * Call every frame; parameter changes glide, so there's no zipper noise.
   */
  setHealth(hp: number, immediate = false) {
    const now = this.ctx.currentTime
    const x = Math.max(0, Math.min(1, (90 - hp) / 75))
    const d = x * x * (3 - 2 * x)
    if (immediate || Math.abs(d - this.damage) > 0.002) {
      this.damage = d
      const set = (p: AudioParam, v: number) => {
        clear(p, now)
        if (immediate) p.setValueAtTime(v, now)
        else p.setTargetAtTime(v, now, 0.25)
      }
      set(this.mDry.gain, 1 - 0.65 * d)
      set(this.driveWet.gain, 0.3 * d)
      set(this.crushWet.gain, 0.25 * d)
      set(this.lowpass.frequency, Math.exp(Math.log(20000) + (Math.log(1100) - Math.log(20000)) * d))
      set(this.lowpass.Q, 0.707 + 5 * d)
      set(this.warbleDepth.gain, 35 * d)
      set(this.flutterDepth.gain, 9 * d)
    }

    const dt = Math.min(0.25, now - this.lastHealthAt)
    this.lastHealthAt = now
    if (immediate) {
      clear(this.micro.gain, now)
      this.micro.gain.setValueAtTime(1, now)
    } else if (hp < 30 && Math.random() < ((30 - hp) / 30) * 2.5 * dt) {
      const g = this.micro.gain
      clear(g, now)
      g.setTargetAtTime(0.03, now, 0.002)
      g.setTargetAtTime(1, now + rand(0.025, 0.09), 0.004)
    }
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
    this.setHealth(100, true)
    const t = this.ctx.currentTime + 0.05
    ;[72, 76, 79, 84, 79, 84].forEach((m, i) => this.blip(midiToHz(m), t + i * 0.1, i === 5 ? 0.5 : 0.09))
  }

  /** Calibration clicks, timed so they're heard `secondsUntil` from now and every `interval` after. */
  clicks(secondsUntil: number, count: number, interval: number) {
    this.setHealth(100, true)
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
    if (ch === 'bass') osc.type = 'triangle'
    else osc.setPeriodicWave(ch === 'lead' ? this.pulse25 : this.pulse12)
    osc.frequency.value = midiToHz(n.midi)
    const end = t + Math.max(0.05, n.d * (ch === 'lead' ? 0.92 : 1))
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.004)
    if (ch === 'lead') g.gain.setTargetAtTime(vol * 0.7, t + 0.05, 0.1)
    g.gain.setTargetAtTime(0, end - 0.015, 0.005)
    osc.connect(g).connect(this.channels[ch].input)
    this.track(osc, ch)
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
    src.connect(f).connect(g).connect(this.channels.drums.input)
    this.track(src, 'drums')
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
    osc.connect(g).connect(this.channels.drums.input)
    this.track(osc, 'drums')
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
