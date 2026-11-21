import { WINDOW, type Judgement } from '../../../shared/protocol'
import type { DrumHit } from '../../../shared/songs'
import { FONT, Game, JUDGE_COLOR, Lane, grade, type GameEnv } from './common'
import { Pixels, disc, ring } from './drums/pixels'

const PADS = ['KICK', 'SNARE', 'TOM']
const PAD_COLOR = ['#ffd23f', '#fff4c2', '#ff8a3d']
const PAD_DARK = ['#3a2c0c', '#36324a', '#3d1d10']
const HEAD = '#17122c'
const STRIP_ROW = 9
const STRIP_H = STRIP_ROW * 3 + 8
const BLOCK = 3
/** A second touch on the same pad this soon is a bounce, not a new stroke (a 156bpm sixteenth is 96ms). */
const DEBOUNCE = 0.045

interface Pad {
  x: number
  y: number
  hitAt: number
  amp: number
  missAt: number
  tapT: number
}

/** Timing rings: a ring closes onto its pad, smash the pad as it lands. A tracker strip up top previews the next bar. */
export class DrumGame extends Game {
  private lane: Lane<DrumHit>
  private result = new Map<DrumHit, Judgement>()
  /** Same-pad hits a sixteenth or less after the previous one (drawn dotted). */
  private quick = new Set<DrumHit>()
  /** First hit of a fast same-pad run -> run length (shown as a x2/x3 badge). */
  private runs = new Map<DrumHit, number>()
  private approach: number
  private pads: Pad[] = [0, 1, 2].map(() => ({ x: 0, y: 0, hitAt: -1e9, amp: 0, missAt: -1e9, tapT: -1e9 }))
  private R = 40
  private Rmax = 80
  private stripY = 8
  private fx = new Pixels()
  private combo = 0
  private lastKickShake = -1e9
  private lastNow = performance.now()

  constructor(env: GameEnv) {
    super(env)
    const { drums, beat } = env.chart
    this.lane = new Lane(drums)
    this.approach = Math.max(0.75, Math.min(1, beat * 2))
    const prev: (DrumHit | undefined)[] = []
    const head: DrumHit[] = []
    for (const h of drums) {
      const p = prev[h.pad]
      if (p && h.t - p.t < beat * 0.3) {
        this.quick.add(h)
        if (!this.quick.has(p)) head[h.pad] = p
        this.runs.set(head[h.pad], (this.runs.get(head[h.pad]) ?? 1) + 1)
      }
      prev[h.pad] = h
    }
  }

  resize(w: number, h: number) {
    super.resize(w, h)
    // Each pad owns a cell its approach ring never leaves: KICK and SNARE split the bottom row, TOM sits above.
    const top = this.stripY + STRIP_H + 10
    this.Rmax = Math.max(40, Math.min(w / 4 - 6, (h - top) / 4.6, 130))
    this.R = Math.round(this.Rmax * 0.5)
    const bottomY = h - this.Rmax - Math.max(14, h * 0.05)
    const dx = Math.min(w / 4, this.Rmax * 1.5)
    this.pads[0].x = w / 2 - dx
    this.pads[1].x = w / 2 + dx
    this.pads[0].y = this.pads[1].y = bottomY
    this.pads[2].x = w / 2
    // TOM: centred in the space above, but no further than a comfortable reach from the bottom row.
    this.pads[2].y = Math.max(top + this.Rmax + 24, bottomY - this.Rmax * 3.1, (top + this.Rmax + bottomY - this.Rmax * 2.1) / 2)
  }

  /** The pad nearest the touch: the whole screen is the kit, so there are no dead zones. */
  private padAt(x: number, y: number) {
    let best = 0
    let bestD = Infinity
    this.pads.forEach((p, i) => {
      const d = Math.hypot(x - p.x, y - p.y)
      if (d < bestD) [best, bestD] = [i, d]
    })
    return best
  }

  update(t: number) {
    this.lane.expire(t, (hit) => {
      const p = this.pads[hit.pad]
      this.result.set(hit, 'miss')
      this.combo = 0
      p.missAt = performance.now()
      this.fx.burst(p.x, p.y, 6, JUDGE_COLOR.miss, 140, this.R)
      this.judge('miss', p.x, p.y - this.Rmax - 6)
    })
  }

  down(x: number, y: number, t: number) {
    const i = this.padAt(x, y)
    const p = this.pads[i]
    const now = performance.now()
    if (t - p.tapT < DEBOUNCE) return
    p.tapT = t
    p.hitAt = now
    p.amp = 0.45
    // Oldest unjudged hit on this pad still in the window, so fast rolls are matched in order.
    let hit: DrumHit | null = null
    for (const h of this.lane.between(t - WINDOW.good, t + WINDOW.good)) {
      if (h.pad === i && !this.lane.judged.has(h)) {
        hit = h
        break
      }
    }
    if (!hit) return
    const r = grade(t - hit.t)
    this.lane.mark(hit)
    this.result.set(hit, r)
    if (r === 'miss') this.combo = 0
    else this.combo++
    const perfect = r === 'perfect'
    p.amp = perfect ? 1 : 0.7
    if (r !== 'miss') {
      this.fx.wave(p.x, p.y, this.R, this.Rmax + 8, perfect ? PAD_COLOR[i] : JUDGE_COLOR.good)
      this.fx.burst(p.x, p.y, perfect ? 10 : 5, PAD_COLOR[i], perfect ? 260 : 170, this.R)
    } else p.missAt = now
    if (perfect && i === 0 && now - this.lastKickShake > 300) {
      this.lastKickShake = now
      this.env.fx.shake(0.38)
    }
    this.judge(r, p.x, p.y - this.Rmax - 6)
    if (r !== 'miss' && (this.combo === 25 || this.combo === 50 || this.combo % 100 === 0)) {
      this.popup(this.combo >= 50 ? `${this.combo} ON FIRE!` : `${this.combo} COMBO!`, PAD_COLOR[2], this.w / 2, this.pads[2].y - this.Rmax - 28, true)
      this.env.fx.flash(PAD_COLOR[2], 0.3)
    }
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastNow) / 1000)
    this.lastNow = now
    this.drawFlames(g, now, dt)
    this.drawStrip(g, t)
    for (let i = 0; i < 3; i++) this.drawPad(g, i, t, now)
    this.drawRings(g, t)
    this.fx.draw(g, dt)
  }

  private drawPad(g: CanvasRenderingContext2D, i: number, t: number, now: number) {
    const p = this.pads[i]
    const { R, Rmax } = this
    const color = PAD_COLOR[i]
    // Damped squash and stretch: wide and short on impact, springing back.
    const e = (now - p.hitAt) / 1000
    const s = e < 0.5 ? p.amp * 0.2 * Math.exp(-e * 12) * Math.cos(e * 38) : 0
    const rx = R * (1 + s)
    const ry = R * (1 - s)
    const press = Math.max(0, 1 - e / 0.12)
    const missed = now - p.missAt < 220
    const live = this.lane.between(t - WINDOW.perfect, t + WINDOW.perfect).some((h) => h.pad === i && !this.lane.judged.has(h))

    // Cell guide: the dotted edge where rings spawn
    ring(g, p.x, p.y, Rmax, Rmax, BLOCK, '#2a2342', 1, 3)
    // Shell, head, rim
    disc(g, p.x, p.y + 6, rx + 2, ry + 2, 4, PAD_DARK[i])
    disc(g, p.x, p.y, rx, ry, 4, press > 0 ? mix(HEAD, color, press * 0.55) : HEAD)
    ring(g, p.x, p.y, rx * 0.62, ry * 0.62, 2, PAD_DARK[i], 1, 2)
    ring(g, p.x, p.y, rx + 2, ry + 2, 4, missed ? JUDGE_COLOR.miss : live ? '#ffffff' : color, 2)

    g.fillStyle = missed ? JUDGE_COLOR.miss : color
    g.font = `${R > 46 ? 10 : 8}px ${FONT}`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(PADS[i], p.x, p.y + 1)
  }

  private drawRings(g: CanvasRenderingContext2D, t: number) {
    const { R, Rmax, approach } = this
    const hits = this.lane.between(t - WINDOW.good, t + approach)
    // Furthest first so the next hit draws on top.
    for (let j = hits.length - 1; j >= 0; j--) {
      const hit = hits[j]
      if (this.lane.judged.has(hit)) continue
      const p = this.pads[hit.pad]
      const k = (hit.t - t) / approach
      const r = R + 2 + (Rmax - R - 2) * Math.max(0, k)
      const near = Math.abs(hit.t - t) <= WINDOW.perfect
      const color = near ? '#ffffff' : PAD_COLOR[hit.pad]
      // Fade in from the cell edge, thicken on the way in.
      g.globalAlpha = Math.min(1, (1 - k) / 0.3)
      ring(g, p.x, p.y, r, r, BLOCK, color, k < 0.45 ? 2 : 1, this.quick.has(hit) ? 2 : 0)
      const run = this.runs.get(hit)
      if (run && k > 0) {
        g.fillStyle = color
        g.font = `8px ${FONT}`
        g.textAlign = 'left'
        g.textBaseline = 'middle'
        g.fillText(`x${run}`, p.x + r * 0.72 + 4, p.y - r * 0.72 - 4)
      }
    }
    g.globalAlpha = 1
  }

  /** A one-bar tracker preview: K/S/T rows scrolling into a playhead. */
  private drawStrip(g: CanvasRenderingContext2D, t: number) {
    const { chart } = this.env
    const y0 = this.stripY
    const x0 = 26
    const head = x0 + 14
    const right = this.w - 8
    const pps = (right - head) / chart.bar
    const from = t - (head - x0) / pps
    const to = t + chart.bar
    const sx = (time: number) => head + (time - t) * pps
    const rowY = (pad: number) => y0 + 4 + pad * STRIP_ROW

    g.fillStyle = '#120e24'
    g.fillRect(x0, y0, right - x0, STRIP_H)
    for (let b = Math.ceil(from / chart.beat); b * chart.beat <= to; b++) {
      const x = Math.round(sx(b * chart.beat))
      g.fillStyle = b % 4 === 0 ? '#3a3260' : '#231d3d'
      g.fillRect(x, y0, b % 4 === 0 ? 2 : 1, STRIP_H)
    }
    g.font = `7px ${FONT}`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (let i = 0; i < 3; i++) {
      g.fillStyle = PAD_COLOR[i]
      g.fillText(PADS[i][0], x0 - 10, rowY(i) + 4)
    }
    const bw = Math.max(3, Math.floor((chart.beat / 4) * pps) - 2)
    for (const hit of this.lane.between(from, to)) {
      const r = this.result.get(hit)
      if (r === 'miss') g.fillStyle = '#5a1a2c'
      else if (r) g.fillStyle = JUDGE_COLOR[r]
      else g.fillStyle = PAD_COLOR[hit.pad]
      g.globalAlpha = r && r !== 'miss' ? 0.6 : 1
      g.fillRect(Math.round(sx(hit.t)), rowY(hit.pad), bw, STRIP_ROW - 2)
    }
    g.globalAlpha = 1
    g.fillStyle = '#ffffff'
    g.fillRect(head - 1, y0 - 2, 2, STRIP_H + 4)
  }

  /** Pixel flames along the bottom edge once a combo gets going. */
  private drawFlames(g: CanvasRenderingContext2D, now: number, dt: number) {
    const heat = Math.min(1, Math.max(0, (this.combo - 8) / 40))
    if (!heat) return
    const s = 6
    const tt = now / 1000
    const bands = ['#c2261a', '#ff6a1f', '#ffd23f']
    for (let band = 0; band < 3; band++) {
      g.beginPath()
      for (let x = 0; x < this.w; x += s) {
        const flick = 0.55 + 0.45 * Math.sin(x * 0.13 + tt * 9) * Math.sin(x * 0.051 - tt * 5.3)
        const blocks = Math.round((heat * (3 + 7 * flick) * this.h) / 700)
        const lo = Math.floor((blocks * band) / 3)
        const hi = Math.floor((blocks * (band + 1)) / 3)
        if (hi > lo) g.rect(x, this.h - hi * s, s, (hi - lo) * s)
      }
      g.fillStyle = bands[band]
      g.globalAlpha = 0.55
      g.fill()
    }
    g.globalAlpha = 1
    if (Math.random() < heat * dt * 30) this.fx.ember(Math.random() * this.w, this.h - 10, Math.random() < 0.5 ? '#ffd23f' : '#ff6a1f')
  }
}

function mix(a: string, b: string, k: number) {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const ch = (sh: number) => Math.round(((pa >> sh) & 255) * (1 - k) + ((pb >> sh) & 255) * k)
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`
}
