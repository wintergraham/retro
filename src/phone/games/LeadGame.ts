import { WINDOW, type Judgement } from '../../../shared/protocol'
import type { LeadNote } from '../../../shared/songs'
import { FONT, Game, JUDGE_COLOR, Lane, grade, type GameEnv } from './common'
import { Sparks, mix } from './lead/pixels'

const HIT_Y = 0.8
const LANES = 4
/** Fraction of a lane's width either side where a tap can also take the neighbouring lane's note. */
const SLACK = 0.3
/** Notes this many beats or longer are hold tiles. */
const HOLD_BEATS = 1.49
const FINGERS = 10
const EARLY = '#3ef0ff'
const LATE = '#ff9a3c'
const GREY = '#3a3550'
const MILESTONES = [10, 25, 50, 100, 150, 200]

// Note states
const PENDING = 0
const HIT = 1
const MISSED = 2
const HOLDING = 3
const HELD = 4
const DROPPED = 5

// Sparks palette
const C_MAIN = 0
const C_LIGHT = 1
const C_WHITE = 2
const C_EARLY = 3
const C_LATE = 4
const C_GREY = 5
const C_RED = 6
const C_GOLD = 7

/**
 * Piano Tiles: four lanes of falling tiles, tap the lane as a tile reaches the line. Long notes are
 * hold tiles: the tap is judged as usual, but a perfect only stands if the tile is held to its tail
 * (letting go early makes it a good). Either way it's one judgement per note.
 */
export class LeadGame extends Game {
  private notes: LeadNote[]
  private lane: Lane<LeadNote>
  private index = new Map<LeadNote, number>()
  private state: Uint8Array
  private isHold: Uint8Array
  /** Song time the note was resolved (hit, missed, dropped), for fades. */
  private doneAt: Float64Array
  private tapR: Judgement[] = []
  /** Whether the note's judgement has already gone to the host. */
  private sent: Uint8Array
  private drawFrom = 0

  private hold = -1
  private holdSlot = -1
  private nextSpark = 0

  private fx = new Float32Array(FINGERS)
  private alive = new Uint8Array(FINGERS)
  private pressAt = [-1e9, -1e9, -1e9, -1e9]
  private pressTint = [0, 0, 0, 0]
  private grads: CanvasGradient[] = []

  private combo = 0
  private comboText = ''
  private comboAt = -1e9
  private lastNow = 0
  private approach: number
  private beat: number
  private tail: (n: LeadNote) => number

  private light: string
  private dark: string
  private deep: string
  private sparks: Sparks
  private feverCols: string[]
  private feverDim: string[]
  private matchLane = 0
  private inLane = (n: LeadNote) => n.lane === this.matchLane

  constructor(env: GameEnv) {
    super(env)
    const { chart, color } = env
    this.notes = chart.lead
    this.lane = new Lane(chart.lead)
    const n = this.notes.length
    this.state = new Uint8Array(n)
    this.isHold = new Uint8Array(n)
    this.sent = new Uint8Array(n)
    this.doneAt = new Float64Array(n)
    this.beat = chart.beat
    this.notes.forEach((note, i) => {
      this.index.set(note, i)
      this.isHold[i] = note.d >= chart.beat * HOLD_BEATS ? 1 : 0
      this.tapR.push('perfect')
    })
    // Same number of beats on screen in every song, kept inside a readable time range.
    this.approach = Math.max(1.05, Math.min(1.7, chart.beat * 3.2))
    // Releasing within this much of a hold's end counts as holding it through.
    this.tail = (note) => Math.min(chart.beat * 0.5, note.d * 0.3)
    this.light = mix(color, '#ffffff', 0.55)
    this.dark = mix(color, '#0b0820', 0.55)
    this.deep = mix(color, '#0b0820', 0.82)
    this.sparks = new Sparks([color, this.light, '#ffffff', EARLY, LATE, '#6a6488', JUDGE_COLOR.miss, '#ffd23f'])
    this.feverCols = [color, '#ffd23f', '#5dff7a', '#3ef0ff', '#b98bff']
    this.feverDim = this.feverCols.map((c) => c + '40')
  }

  resize(w: number, h: number) {
    super.resize(w, h)
    const g = document.createElement('canvas').getContext('2d')!
    this.grads = [this.env.color, EARLY, LATE, JUDGE_COLOR.miss, '#ffffff'].map((c) => {
      const grad = g.createLinearGradient(0, h * HIT_Y, 0, 0)
      grad.addColorStop(0, c)
      grad.addColorStop(1, c + '00')
      return grad
    })
  }

  private get lw() {
    return this.w / LANES
  }

  private cx(lane: number) {
    return (lane + 0.5) * this.lw
  }

  private send(i: number, r: Judgement, weight = 1) {
    this.sent[i] = 1
    const note = this.notes[i]
    this.judge(r, this.cx(note.lane), this.h * HIT_Y - 30, weight)
    if (r === 'miss') {
      this.combo = 0
      this.comboText = ''
      return
    }
    this.combo++
    this.comboText = String(this.combo)
    this.comboAt = performance.now()
    if (MILESTONES.includes(this.combo)) {
      this.popup(`${this.combo} COMBO!`, '#ffd23f', this.w / 2, this.h * 0.24, true)
      this.env.fx.flash('#ffd23f', 0.25)
    }
  }

  update(t: number) {
    // Taps arrive with inputOffset already removed, so run the chart on that same corrected clock.
    const tj = t - this.env.inputOffset
    this.lane.expire(tj, (note) => {
      const i = this.index.get(note)!
      this.state[i] = MISSED
      this.doneAt[i] = tj
      this.pressAt[note.lane] = performance.now()
      this.pressTint[note.lane] = 3
      this.puff(this.cx(note.lane), C_RED, 8)
      this.send(i, 'miss', this.isHold[i] ? 1.3 : 1)
    })
    if (this.hold >= 0) {
      const note = this.notes[this.hold]
      if (tj >= note.t + note.d - this.tail(note)) this.finishHold(tj, true)
    }
  }

  private finishHold(t: number, through: boolean) {
    const i = this.hold
    const note = this.notes[i]
    this.hold = -1
    this.holdSlot = -1
    this.doneAt[i] = t
    const x = this.cx(note.lane)
    const hitY = this.h * HIT_Y
    if (through) {
      this.state[i] = HELD
      const r = this.tapR[i]
      if (!this.sent[i]) this.send(i, r, 1.2)
      const lw = this.lw
      this.sparks.shatter(x - lw * 0.22, hitY - lw * 0.9, lw * 0.44, lw * 0.9, r === 'perfect' ? C_LIGHT : C_MAIN, 1.1, r === 'perfect' ? C_GOLD : C_WHITE)
    } else {
      this.state[i] = DROPPED
      this.puff(x, C_GREY, 6)
      if (!this.sent[i]) {
        this.send(i, 'good')
        this.popup('LET GO', '#8f88b8', x, hitY - 56)
      }
    }
  }

  private puff(x: number, col: number, n: number) {
    const y = this.h * HIT_Y
    for (let k = 0; k < n; k++) {
      this.sparks.spawn(x + (Math.random() - 0.5) * this.lw * 0.7, y, (Math.random() - 0.5) * 220, -80 - Math.random() * 200, 0.4, 4, col)
    }
  }

  down(x: number, _y: number, t: number) {
    let slot = 0
    while (slot < FINGERS - 1 && this.alive[slot]) slot++
    this.alive[slot] = 1
    this.fx[slot] = x

    const lw = this.lw
    const li = Math.max(0, Math.min(LANES - 1, Math.floor(x / lw)))
    const now = performance.now()
    this.pressAt[li] = now
    this.pressTint[li] = 4
    this.matchLane = li
    let note = this.lane.nearest(t, this.inLane)
    if (!note) {
      // Generous hitboxes: a tap near a lane edge can take the neighbour's note.
      const frac = x / lw - li
      const nb = frac < SLACK ? li - 1 : frac > 1 - SLACK ? li + 1 : -1
      if (nb >= 0 && nb < LANES) {
        this.matchLane = nb
        note = this.lane.nearest(t, this.inLane)
      }
    }
    if (!note) return
    const i = this.index.get(note)!
    const delta = t - note.t
    const r = grade(delta)
    this.lane.mark(note)
    this.tapR[i] = r
    this.doneAt[i] = t
    const tint = r === 'perfect' ? 0 : delta < 0 ? 1 : 2
    this.pressAt[note.lane] = now
    this.pressTint[note.lane] = tint

    const hitY = this.h * HIT_Y
    const cx = this.cx(note.lane)
    const tw = lw - 10
    const th = this.tileH(note, i)
    const shard = r === 'perfect' ? C_MAIN : tint === 1 ? C_EARLY : C_LATE
    this.sparks.shatter(cx - tw / 2, hitY - th, tw, th, shard, r === 'perfect' ? 1 : 0.7, r === 'perfect' ? C_WHITE : shard)
    if (r === 'good') this.popup(delta < 0 ? 'EARLY' : 'LATE', tint === 1 ? EARLY : LATE, cx, hitY - 56)

    if (this.isHold[i]) {
      if (this.hold >= 0) this.finishHold(t, true)
      this.state[i] = HOLDING
      this.hold = i
      this.holdSlot = slot
      if (r === 'perfect') {
        // The perfect is only banked once the hold is through, so for now it's just local feedback.
        this.env.sound('perfect')
        this.env.fx.flash(this.env.color, 0.2)
        this.popup('HOLD!', this.light, cx, hitY - 30, true)
        navigator.vibrate?.(12)
      } else this.send(i, r)
    } else {
      this.state[i] = HIT
      this.send(i, r)
    }
  }

  private nearestFinger(x: number) {
    let best = -1
    let bestD = Infinity
    for (let s = 0; s < FINGERS; s++) {
      if (!this.alive[s]) continue
      const d = Math.abs(this.fx[s] - x)
      if (d < bestD) [best, bestD] = [s, d]
    }
    return best
  }

  move(x: number) {
    const s = this.nearestFinger(x)
    if (s >= 0) this.fx[s] = x
  }

  up(x: number, _y: number, t: number) {
    const s = this.nearestFinger(x)
    if (s < 0) return
    this.alive[s] = 0
    if (s !== this.holdSlot || this.hold < 0) return
    const note = this.notes[this.hold]
    this.finishHold(t, t >= note.t + note.d - this.tail(note))
  }

  private tileH(note: LeadNote, i: number) {
    const pps = (this.h * HIT_Y) / this.approach
    const max = this.isHold[i] ? 34 : this.lw * 0.75
    return Math.max(22, Math.min(max, note.d * pps - 6))
  }

  /** A chunky pixel tile: dark outline, body, top highlight and a darker key lip at the bottom. */
  private tile(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, body: string, light: string, lip: string) {
    x = Math.round(x)
    y = Math.round(y)
    w = Math.round(w)
    h = Math.round(h)
    g.fillStyle = '#0b0820'
    g.fillRect(x, y, w, h)
    g.fillStyle = body
    g.fillRect(x + 2, y + 2, w - 4, h - 4)
    g.fillStyle = light
    g.fillRect(x + 2, y + 2, w - 4, 3)
    g.fillRect(x + 2, y + 2, 3, h - 4)
    if (h > 14) {
      g.fillStyle = lip
      g.fillRect(x + 2, y + h - 8, w - 4, 6)
    }
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const { w, h, notes } = this
    const color = this.env.color
    const tv = t - this.env.inputOffset
    const hitY = Math.round(h * HIT_Y)
    const lw = this.lw
    const pps = hitY / this.approach
    const now = performance.now()
    const dt = this.lastNow ? Math.min(0.05, (now - this.lastNow) / 1000) : 0
    this.lastNow = now
    const tier = this.combo >= 50 ? 3 : this.combo >= 25 ? 2 : this.combo >= 10 ? 1 : 0
    const beatPos = tv / this.beat
    const pulse = tv > 0 ? Math.pow(1 - (beatPos - Math.floor(beatPos)), 3) : 0
    const feverI = tier === 3 ? Math.floor(Math.max(0, beatPos)) % this.feverCols.length : 0
    const lineCol = this.feverCols[feverI]

    // Lane shading, with a beat pulse that grows with the combo
    for (let i = 0; i < LANES; i++) {
      if (i % 2) {
        g.fillStyle = 'rgba(255,255,255,0.025)'
        g.fillRect(i * lw, 0, lw, hitY)
      }
    }
    if (tier) {
      g.globalAlpha = pulse * 0.05 * tier
      g.fillStyle = lineCol
      g.fillRect(0, 0, w, hitY)
      g.globalAlpha = 1
    }

    // Beat and bar lines scrolling with the tiles, so the rhythm reads before it arrives
    const firstBeat = Math.ceil(tv / this.beat)
    const lastBeat = Math.floor((tv + this.approach) / this.beat)
    for (let b = firstBeat; b <= lastBeat; b++) {
      const y = Math.round(hitY - (b * this.beat - tv) * pps)
      const bar = b % 4 === 0
      g.globalAlpha = Math.min(1, y / (hitY * 0.25))
      g.fillStyle = bar ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)'
      g.fillRect(0, y - (bar ? 1 : 0), w, bar ? 2 : 1)
    }
    g.globalAlpha = 1

    // Press flashes (tinted early/late/miss) and a steady glow under a held finger
    for (let i = 0; i < LANES; i++) {
      let f = Math.max(0, 1 - (now - this.pressAt[i]) / 220)
      let tint = this.pressTint[i]
      if (this.hold >= 0 && notes[this.hold].lane === i) {
        f = Math.max(f, 0.55 + 0.15 * Math.sin(now / 60))
        tint = 0
      }
      if (f <= 0) continue
      g.globalAlpha = (tint === 4 ? 0.18 : 0.4) * f
      g.fillStyle = this.grads[tint]
      g.fillRect(i * lw, 0, lw, hitY)
    }
    g.globalAlpha = 1

    // Lane dividers
    g.fillStyle = tier ? this.feverDim[feverI] : 'rgba(255,255,255,0.08)'
    for (let i = 1; i < LANES; i++) g.fillRect(Math.round(i * lw) - 1, 0, 2, h)

    // Tiles
    while (this.drawFrom < notes.length) {
      const n = notes[this.drawFrom]
      if (n.t + n.d + 1.5 > tv || this.state[this.drawFrom] === HOLDING) break
      this.drawFrom++
    }
    let target = -1
    for (let i = this.drawFrom; i < notes.length; i++) {
      const n = notes[i]
      if (n.t > tv + this.approach) break
      const st = this.state[i]
      if (st === HIT || st === HELD) continue
      if (target < 0 && st === PENDING) target = i
      const x = n.lane * lw + 5
      const tw = lw - 10
      const th = this.tileH(n, i)
      let bottom = hitY - (n.t - tv) * pps
      const tailY = hitY - (n.t + n.d - tv) * pps
      if (tailY > h) continue
      const dead = st === MISSED || st === DROPPED
      g.globalAlpha = Math.max(0, Math.min(1, (bottom + 20) / (hitY * 0.2)))

      if (this.isHold[i]) {
        if (st === HOLDING) bottom = hitY
        // A dropped hold leaves its unplayed rest draining grey into the line
        if (st === DROPPED) bottom = Math.min(bottom, hitY + th - 4)
        const rw = Math.round(tw * 0.44)
        const rx = Math.round(x + (tw - rw) / 2)
        const top = Math.round(tailY)
        const railBottom = Math.round(bottom - th + 4)
        if (railBottom > top) {
          g.fillStyle = '#0b0820'
          g.fillRect(rx - 2, top - 2, rw + 4, railBottom - top + 2)
          g.fillStyle = dead ? GREY : st === HOLDING ? this.light : this.dark
          g.fillRect(rx, top, rw, railBottom - top)
          // Pixel ridges along the rail, scrolling with it
          g.fillStyle = dead ? '#2a2640' : st === HOLDING ? '#ffffff' : color
          const step = 12
          const off = (((tailY % step) + step) % step)
          for (let y = top + off; y < railBottom - 2; y += step) g.fillRect(rx + 2, Math.round(y), rw - 4, 2)
          // Tail cap
          g.fillStyle = dead ? GREY : color
          g.fillRect(rx - 4, top - 4, rw + 8, 6)
        }
      }

      if (st === DROPPED) continue
      if (dead) {
        const blink = st === MISSED && tv - this.doneAt[i] < 0.35 && Math.floor(now / 70) % 2 === 0
        this.tile(g, x, bottom - th, tw, th, blink ? JUDGE_COLOR.miss : GREY, '#4c4668', '#2a2640')
      } else if (st === HOLDING) {
        const glow = 0.5 + 0.5 * Math.sin(now / 50)
        this.tile(g, x, hitY - th, tw, th, glow > 0.5 ? this.light : color, '#ffffff', color)
      } else {
        this.tile(g, x, bottom - th, tw, th, color, this.light, this.dark)
        if (this.isHold[i]) {
          // Hold marker: a small notch pattern on the head
          g.fillStyle = '#0b0820'
          g.fillRect(Math.round(x + tw / 2 - 5), Math.round(bottom - th / 2 - 4), 10, 4)
        }
      }
    }
    g.globalAlpha = 1

    // Corner brackets on the next tile to hit once it's within a beat or so
    if (target >= 0) {
      const n = notes[target]
      const dtn = n.t - tv
      if (dtn < this.beat * 1.5 && dtn > -WINDOW.good) {
        const th = this.tileH(n, target)
        const bottom = hitY - dtn * pps
        const k = Math.max(0, Math.min(1, 1 - dtn / (this.beat * 1.5)))
        const x0 = Math.round(n.lane * lw + 1)
        const x1 = Math.round((n.lane + 1) * lw - 1)
        const y0 = Math.round(bottom - th - 4)
        const y1 = Math.round(bottom + 4)
        const s = 8
        g.globalAlpha = k
        g.fillStyle = '#ffffff'
        g.fillRect(x0, y0, s, 2)
        g.fillRect(x0, y0, 2, s)
        g.fillRect(x1 - s, y0, s, 2)
        g.fillRect(x1 - 2, y0, 2, s)
        g.fillRect(x0, y1 - 2, s, 2)
        g.fillRect(x0, y1 - s, 2, s)
        g.fillRect(x1 - s, y1 - 2, s, 2)
        g.fillRect(x1 - 2, y1 - s, 2, s)
        g.globalAlpha = 1
      }
    }

    // Hold sparks
    if (this.hold >= 0 && now >= this.nextSpark) {
      this.nextSpark = now + 40
      const cx = this.cx(notes[this.hold].lane)
      for (let k = 0; k < 2; k++) {
        this.sparks.spawn(cx + (Math.random() - 0.5) * lw * 0.6, hitY, (Math.random() - 0.5) * 160, -200 - Math.random() * 260, 0.35, 3, k ? C_WHITE : C_LIGHT)
      }
    }

    // Hit line: a soft band behind a solid core, thicker as the combo builds
    const thick = 4 + tier * 2
    g.globalAlpha = 0.22 + pulse * 0.15
    g.fillStyle = lineCol
    g.fillRect(0, hitY - thick - 4, w, thick * 2 + 8)
    g.globalAlpha = 1
    g.fillRect(0, hitY - thick / 2, w, thick)
    g.fillStyle = tier === 3 ? '#ffffff' : this.light
    g.fillRect(0, hitY - 1, w, 2)

    // Keys below the line, pushed in while a finger is on them
    const keyTop = hitY + thick / 2 + 6
    const keyH = h - keyTop - 8
    if (keyH > 16) {
      for (let i = 0; i < LANES; i++) {
        let down = now - this.pressAt[i] < 90 || (this.hold >= 0 && notes[this.hold].lane === i)
        for (let s = 0; s < FINGERS && !down; s++) down = !!this.alive[s] && Math.floor(this.fx[s] / lw) === i
        const kx = Math.round(i * lw + 6)
        const kw = Math.round(lw - 12)
        const dy = down ? 3 : 0
        g.fillStyle = '#0b0820'
        g.fillRect(kx, keyTop, kw, keyH)
        g.fillStyle = down ? this.dark : this.deep
        g.fillRect(kx + 2, keyTop + 2 + dy, kw - 4, keyH - 4 - dy)
        g.fillStyle = down ? color : this.dark
        g.fillRect(kx + 2, keyTop + 2 + dy, kw - 4, 3)
        if (!down) {
          g.fillStyle = '#0b0820'
          g.fillRect(kx + 2, keyTop + keyH - 6, kw - 4, 4)
        }
      }
    }

    this.sparks.update(dt)
    this.sparks.draw(g)

    // Combo counter, bumped on each hit
    if (this.combo >= 5) {
      const bump = Math.max(0, 1 - (now - this.comboAt) / 160)
      const s = 1 + bump * 0.25
      g.save()
      g.translate(w / 2, h * 0.13)
      g.scale(s, s)
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.font = `26px ${FONT}`
      g.fillStyle = '#0b0820'
      g.fillText(this.comboText, 3, 3)
      g.fillStyle = tier === 3 ? lineCol : tier ? '#ffd23f' : '#ffffff'
      g.fillText(this.comboText, 0, 0)
      g.font = `9px ${FONT}`
      g.fillStyle = tier ? lineCol : 'rgba(255,255,255,0.6)'
      g.fillText('COMBO', 0, 26)
      g.restore()
    }
  }
}
