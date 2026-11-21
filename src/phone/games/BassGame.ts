import type { Judgement } from '../../../shared/protocol'
import { bassTrackX } from '../../../shared/songs'
import { FONT, Game, JUDGE_COLOR, type GameEnv } from './common'
import { Tilt } from './bass/tilt'

const LOOKAHEAD = 2 // seconds of track above the ship
const SHIP_Y = 0.78
const CORE = 0.075 // half-widths in screen widths; the host forgives drift under 0.07
const BAND = 0.16
const PX = 4 // pixel-art grid, CSS px
const CELL = 3 // ship sprite pixel size
// Drift is measured against the track a little either side of now, mostly behind: steering
// lags what you see, and a quick glide between chord roots shouldn't punish that lag.
const SLACK = [-0.12, -0.06, 0, 0.04]
const BEND_MS = 62 // ~15Hz at 60/120fps
const BLEND_MS = 350 // hand back from a finger to tilt without a jump
const LOCK = 4 // perfects in a row to lock on

const SHIP = ['....A....', '...AWA...', '...AWA...', '..AAWAA..', '..AAAAA..', '.AABABAA.', 'AAAAAAAAA', 'AA.AAA.AA', 'A...A...A']

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const snap = (v: number) => Math.round(v / 2) * 2

/** Tilt ship: steer along the scrolling bassline. Drift off it and the bass bends out of tune. */
export class BassGame extends Game {
  private tilt = new Tilt()
  private shipX = 0.5
  private vx = 0
  private dragging = false
  private touchX = 0.5
  private touchUntil = -Infinity
  private lastT: number | null = null
  private lastBend = 0
  private bentOff = false
  /** Beat being averaged right now; starts at the beat the game was created in, so a late first frame still judges what it missed. */
  private beat: number
  private devSum = 0
  private devW = 0
  private dev = 0
  private drift = 0
  private streak = 0
  private lockAt = -Infinity
  private noteIdx = 0
  private pulseT = -Infinity
  private trail: { x: number; t: number }[] = []
  private sparks: Spark[] = []
  private xs = new Float32Array(0)
  private stars = Array.from({ length: 40 }, (_, i) => ({ x: Math.random(), y: Math.random(), z: i % 3 === 0 ? 1 : 0.45 }))

  constructor(env: GameEnv) {
    super(env)
    this.beat = Math.floor(env.startT / env.chart.beat)
  }

  destroy() {
    this.tilt.destroy()
  }

  down(x: number) {
    this.dragging = true
    this.touchX = clamp(x / this.w, 0, 1)
  }

  move(x: number) {
    if (this.dragging) this.touchX = clamp(x / this.w, 0, 1)
  }

  up() {
    if (!this.dragging) return
    this.dragging = false
    this.touchUntil = performance.now() + BLEND_MS
  }

  private trackDev(x: number, tv: number) {
    let best = Infinity
    for (const s of SLACK) {
      const d = x - bassTrackX(this.env.chart, tv + s)
      if (Math.abs(d) < Math.abs(best)) best = d
    }
    return best
  }

  update(t: number) {
    const { chart, inputOffset } = this.env
    const now = performance.now()
    const dt = this.lastT == null ? 0 : clamp(t - this.lastT, 0, 0.1)
    this.lastT = t
    // A late player chases the track late too, so the track is shown and judged inputOffset behind.
    const tv = t - inputOffset

    if (this.tilt.calibrate(t)) this.popup('CENTRED', this.env.color, this.w / 2, this.h * 0.45)

    // Steering: a finger wins while it's down, then hands back to tilt over BLEND_MS.
    const tiltX = this.tilt.x()
    let target = this.touchX
    if (!this.dragging && tiltX != null) {
      const k = clamp((this.touchUntil - now) / BLEND_MS, 0, 1)
      target = tiltX + (this.touchX - tiltX) * k
    }
    const prev = this.shipX
    this.shipX = clamp(this.shipX + (target - this.shipX) * (1 - Math.exp(-dt * (this.dragging ? 30 : 22))), 0.02, 0.98)
    if (dt > 0) this.vx += ((this.shipX - prev) / dt - this.vx) * (1 - Math.exp(-dt * 12))

    this.dev = this.trackDev(this.shipX, tv)
    const off = Math.abs(this.dev)
    this.drift += (clamp((off - CORE) / (BAND * 1.6 - CORE), 0, 1) - this.drift) * (1 - Math.exp(-dt * 8))

    const playing = t >= 0 && t < chart.duration
    if (playing && now - this.lastBend >= BEND_MS) {
      this.lastBend = now
      this.env.bend(this.dev)
    } else if (!playing && t > 0 && !this.bentOff) {
      this.bentOff = true
      this.env.bend(0)
    }

    // One judgement per beat, on the average drift across it.
    const total = Math.round(chart.duration / chart.beat)
    const beat = Math.floor(t / chart.beat)
    if (beat !== this.beat) {
      if (beat > this.beat) {
        if (this.beat >= 0 && this.beat < total) this.grade(this.devW ? this.devSum / this.devW : Infinity)
        // Whole beats without a single frame (screen locked, tab hidden) count as missed.
        for (let b = Math.max(0, this.beat + 1); b < Math.min(beat, total); b++) this.env.judge('miss')
      }
      this.beat = beat
      this.devSum = 0
      this.devW = 0
    }
    if (playing) {
      const wt = dt || 1 / 60
      this.devSum += off * wt
      this.devW += wt
    }

    // Bass note onsets pulse the track.
    while (this.noteIdx < chart.bass.length && chart.bass[this.noteIdx].t <= tv) this.pulseT = chart.bass[this.noteIdx++].t

    const shipY = this.h * SHIP_Y
    const speed = shipY / LOOKAHEAD
    this.trail.push({ x: this.shipX, t: tv })
    while (this.trail.length && tv - this.trail[0].t > 0.7) this.trail.shift()

    // Grinding the edge of the band throws sparks off it.
    if (t > -1.6 && off > BAND - 0.03 && off < BAND + 0.04 && Math.random() < dt * 50) {
      const side = Math.sign(this.dev) || 1
      const ex = (bassTrackX(chart, tv) + side * BAND) * this.w
      for (let i = 0; i < 2; i++) {
        this.sparks.push({ x: ex, y: shipY + (Math.random() - 0.5) * 16, vx: side * (40 + Math.random() * 120), vy: -60 + Math.random() * 80, life: 0.25 + Math.random() * 0.25 })
      }
      if (this.sparks.length > 80) this.sparks.splice(0, this.sparks.length - 80)
    }
    for (const s of this.sparks) {
      s.x += s.vx * dt
      s.y += (s.vy + speed) * dt
      s.vy += 400 * dt
      s.life -= dt
    }
    this.sparks = this.sparks.filter((s) => s.life > 0)
  }

  private grade(avg: number) {
    const r: Judgement = avg < CORE ? 'perfect' : avg < BAND ? 'good' : 'miss'
    const broke = r === 'miss' && this.streak >= LOCK
    // Every beat is judged, so keep the per-beat screen FX lighter than a tap game's.
    const weight = r === 'perfect' ? 0.5 : r === 'good' ? 0.7 : this.streak > 0 ? 1 : 0.6
    this.streak = r === 'perfect' ? this.streak + 1 : r === 'good' ? this.streak : 0
    const x = this.shipX * this.w
    const y = this.h * SHIP_Y
    // Pop the label beside the ship, on the roomier side, so it doesn't cover the track ahead.
    this.judge(r, x + (this.shipX < 0.5 ? 70 : -70), y - 6, weight)
    if (r === 'perfect' && this.streak === LOCK) {
      this.lockAt = performance.now()
      this.popup('LOCKED ON', this.env.color, this.w / 2, this.h * 0.3, true)
      this.env.fx.flash(this.env.color, 0.35)
    }
    if (broke) {
      this.popup('LOST LOCK', JUDGE_COLOR.miss, this.w / 2, this.h * 0.3)
      this.env.fx.glitch(0.4)
    }
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const { w, h, env } = this
    const { chart } = env
    const color = env.color
    const now = performance.now()
    const tv = t - env.inputOffset
    const shipY = Math.round(h * SHIP_Y)
    const speed = shipY / LOOKAHEAD
    const yAt = (time: number) => shipY - (time - tv) * speed
    const drift = this.drift
    const pulse = Math.exp(-Math.max(0, tv - this.pulseT) * 9)
    const locked = this.streak >= LOCK
    const off = Math.abs(this.dev)
    const state = off < CORE ? '#fff' : off < BAND ? JUDGE_COLOR.good : JUDGE_COLOR.miss

    // Starfield scrolling with the track
    g.fillStyle = '#fff'
    for (const s of this.stars) {
      const y = (((s.y * h + tv * speed * s.z) % h) + h) % h
      g.globalAlpha = s.z === 1 ? 0.35 : 0.15
      g.fillRect(snap(s.x * w), snap(y), 2, s.z === 1 ? 4 : 2)
    }

    // Beat rungs across the screen, brighter on the bar
    const perBar = Math.round(chart.bar / chart.beat)
    g.fillStyle = color
    for (let b = Math.ceil((tv - (h - shipY) / speed) / chart.beat); b * chart.beat <= tv + LOOKAHEAD; b++) {
      g.globalAlpha = b % perBar === 0 ? 0.14 : 0.05
      g.fillRect(0, Math.round(yAt(b * chart.beat)), w, b % perBar === 0 ? 2 : 1)
    }

    // Track centre per pixel row. Drifting warps it, like the pitch it stands for.
    const rows = Math.ceil(h / PX) + 1
    if (this.xs.length !== rows) this.xs = new Float32Array(rows)
    const xs = this.xs
    const warp = drift * 16
    for (let i = 0; i < rows; i++) {
      const y = i * PX + PX / 2
      const x = bassTrackX(chart, tv + (shipY - y) / speed) * w
      xs[i] = warp ? x + Math.sin(y * 0.045 + now * 0.013) * warp * (0.6 + 0.4 * Math.sin(now * 0.021 + i)) : x
    }
    const shipRow = Math.floor(shipY / PX)
    const rowsPath = (half: number, from: number, to: number, every = 1, edge = 0) => {
      g.beginPath()
      const scroll = Math.floor((tv * speed) / PX)
      for (let i = from; i < to; i++) {
        if (every > 1 && (i - scroll) % every !== 0) continue
        if (edge) {
          g.rect(snap(xs[i] - half) - edge / 2, i * PX, edge, PX)
          if (half) g.rect(snap(xs[i] + half) - edge / 2, i * PX, edge, PX)
        } else g.rect(snap(xs[i] - half), i * PX, snap(half * 2), PX)
      }
    }
    const band = BAND * w
    const core = CORE * w * (1 + pulse * 0.12)
    const glow = locked ? 0.5 + 0.5 * Math.sin(now * 0.008) : 0
    for (const [from, to, dim] of [[0, shipRow, 1], [shipRow, rows, 0.45]] as const) {
      g.fillStyle = color
      g.globalAlpha = (0.08 + pulse * 0.05) * dim
      rowsPath(band, from, to)
      g.fill()
      g.globalAlpha = (0.22 + pulse * 0.18 + glow * 0.12) * dim
      rowsPath(core, from, to)
      g.fill()
      g.globalAlpha = 0.55 * dim
      rowsPath(band, from, to, 2, 2)
      g.fill()
      g.globalAlpha = (0.6 + pulse * 0.4) * dim
      rowsPath(core, from, to, 1, 2)
      g.fill()
      // Centre line, split into colour fringes as it detunes
      const split = Math.round(drift * 6)
      if (split) {
        g.globalAlpha = 0.7 * dim
        g.fillStyle = '#ff3b8a'
        rowsPath(0, from, to, 1, 2)
        g.translate(split, 0)
        g.fill()
        g.translate(-split * 2, 0)
        g.fillStyle = '#3ef0ff'
        g.fill()
        g.translate(split, 0)
      }
      g.globalAlpha = dim
      g.fillStyle = '#fff'
      rowsPath(0, from, to, 3, 2)
      g.fill()
    }

    // Bass notes as rungs across the core, flashing as they pass the ship
    for (let i = Math.max(0, this.noteIdx - 4); i < chart.bass.length; i++) {
      const n = chart.bass[i]
      if (n.t > tv + LOOKAHEAD) break
      const y = yAt(n.t)
      if (y > h) continue
      const row = clamp(Math.floor(y / PX), 0, rows - 1)
      const hit = Math.exp(-Math.abs(tv - n.t) * 14)
      g.globalAlpha = (y > shipY ? 0.25 : 0.55) + hit * 0.45
      g.fillStyle = hit > 0.4 ? '#fff' : color
      const half = core * (0.7 + hit * 0.5)
      g.fillRect(snap(xs[row] - half), Math.round(y) - PX / 2, snap(half * 2), PX)
    }
    g.globalAlpha = 1

    // Engine trail, glued to the scrolling world so it traces the line you actually flew
    g.fillStyle = color
    for (let i = this.trail.length - 1; i >= 0; i -= 2) {
      const p = this.trail[i]
      const age = tv - p.t
      const y = shipY + 14 + age * speed
      if (y > h) break
      const s = Math.max(2, Math.round((1 - age / 0.7) * 3) * 2)
      g.globalAlpha = 0.7 * (1 - age / 0.7)
      g.fillRect(snap(p.x * w) - s / 2, Math.round(y), s, s)
    }

    // Sparks
    g.fillStyle = JUDGE_COLOR.good
    for (const s of this.sparks) {
      g.globalAlpha = Math.min(1, s.life * 4)
      g.fillRect(Math.round(s.x), Math.round(s.y), 3, 3)
    }

    // Ship: banks into turns, wobbles harder the further it drifts
    const lean = clamp(this.vx * 0.5, -1, 1)
    const wob = drift > 0.05 ? Math.round(Math.sin(now * 0.05) * drift * 3) * CELL : 0
    const x0 = Math.round(this.shipX * w) + wob
    const y0 = shipY - (SHIP.length * CELL) / 2
    const halo = (locked ? 30 + glow * 8 : 22) + pulse * 4
    g.fillStyle = locked ? color : state
    g.globalAlpha = locked ? 0.22 : 0.12
    g.beginPath()
    g.arc(x0, shipY, halo, 0, Math.PI * 2)
    g.fill()
    g.globalAlpha = 1
    const flame = 2 + Math.round(Math.random() * 3)
    g.fillStyle = color
    g.fillRect(x0 - CELL, y0 + SHIP.length * CELL, CELL * 2 + 1, flame * CELL)
    g.fillStyle = '#fff'
    g.fillRect(x0 - 1, y0 + SHIP.length * CELL, 3, (flame - 1) * CELL)
    for (const [ch, fill] of [['A', state], ['W', color], ['B', '#0b0820']] as const) {
      g.fillStyle = fill
      g.beginPath()
      SHIP.forEach((row, r) => {
        const shift = Math.round(lean * 1.5 * (1 - r / (SHIP.length - 1))) * CELL
        for (let c = 0; c < row.length; c++) {
          if (row[c] === ch) g.rect(x0 + (c - 4.5) * CELL + shift, y0 + r * CELL, CELL, CELL)
        }
      })
      g.fill()
    }

    // Way back to the track when you've lost it
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    if (off > BAND && t > -1.6 && Math.floor(now / 160) % 2 === 0) {
      const dir = -Math.sign(this.dev)
      g.font = `12px ${FONT}`
      g.fillStyle = JUDGE_COLOR.miss
      g.fillText(dir > 0 ? '>>' : '<<', x0 + dir * 34, shipY + 2)
    }

    // Tuner: how far out of tune the bass is right now
    const tw = Math.min(180, w * 0.5)
    const tx = w / 2
    const ty = 18
    g.globalAlpha = 0.85
    g.fillStyle = 'rgba(255,255,255,0.15)'
    g.fillRect(tx - tw / 2, ty - 1, tw, 2)
    g.fillStyle = JUDGE_COLOR.perfect
    g.fillRect(tx - (CORE / 0.3) * (tw / 2), ty - 3, (CORE / 0.3) * tw, 6)
    g.fillStyle = state
    g.fillRect(snap(tx + clamp(this.dev / 0.3, -1, 1) * (tw / 2)) - 2, ty - 7, 4, 14)
    g.font = `8px ${FONT}`
    g.fillStyle = 'rgba(255,255,255,0.6)'
    g.fillText('b', tx - tw / 2 - 10, ty + 1)
    g.fillText('#', tx + tw / 2 + 10, ty + 1)
    g.globalAlpha = 1
    if (locked) {
      g.fillStyle = color
      g.globalAlpha = now - this.lockAt < 400 ? 1 : 0.6 + glow * 0.4
      g.fillText(`LOCKED x${this.streak}`, tx, ty + 18)
      g.globalAlpha = 1
    }

    // Control hint around the start
    if (t < 3) {
      const tilting = this.tilt.active
      g.font = `9px ${FONT}`
      g.fillStyle = color
      g.globalAlpha = t < 2 ? 0.9 : 3 - t
      const hint = t < -1 && tilting ? 'HOLD STEADY...' : tilting ? 'TILT TO STEER · OR DRAG' : 'DRAG TO STEER'
      g.fillText(hint, w / 2, shipY + 56)
      g.globalAlpha = 1
    }
  }
}
