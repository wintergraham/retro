import type { DrumHit } from '../../../shared/songs'
import { FONT, Game, Lane, grade, type GameEnv } from './common'

const APPROACH = 0.9
const PADS = ['KICK', 'SNARE', 'TOM']

/** Timing rings: a ring shrinks onto its pad, smash the pad as it closes. */
export class DrumGame extends Game {
  private lane: Lane<DrumHit>
  private flash = [0, 0, 0]

  constructor(env: GameEnv) {
    super(env)
    this.lane = new Lane(env.chart.drums)
  }

  private get radius() {
    return Math.min(this.w * 0.2, this.h * 0.13)
  }

  private pad(i: number) {
    const { w, h } = this
    return i === 0 ? { x: w * 0.27, y: h * 0.7 } : i === 1 ? { x: w * 0.73, y: h * 0.7 } : { x: w * 0.5, y: h * 0.38 }
  }

  update(t: number) {
    this.lane.expire(t, (hit) => {
      const p = this.pad(hit.pad)
      this.judge('miss', p.x, p.y - this.radius - 14)
    })
  }

  down(x: number, y: number, t: number) {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < 3; i++) {
      const p = this.pad(i)
      const d = Math.hypot(x - p.x, y - p.y)
      if (d < bestD) [best, bestD] = [i, d]
    }
    if (bestD > this.radius * 1.9) return
    this.flash[best] = performance.now()
    const hit = this.lane.nearest(t, (h) => h.pad === best)
    if (!hit) return
    this.lane.mark(hit)
    const p = this.pad(best)
    this.judge(grade(t - hit.t), p.x, p.y - this.radius - 14)
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const color = this.env.color
    const r = this.radius
    const now = performance.now()

    for (let i = 0; i < 3; i++) {
      const p = this.pad(i)
      const f = Math.max(0, 1 - (now - this.flash[i]) / 150)
      g.beginPath()
      g.arc(p.x, p.y, r * (1 - f * 0.06), 0, Math.PI * 2)
      g.fillStyle = f > 0 ? `rgba(255,255,255,${0.12 + f * 0.5})` : 'rgba(255,255,255,0.06)'
      g.fill()
      g.lineWidth = 4
      g.strokeStyle = color
      g.shadowColor = color
      g.shadowBlur = 10 + f * 20
      g.stroke()
      g.shadowBlur = 0
      g.fillStyle = color
      g.font = `10px ${FONT}`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(PADS[i], p.x, p.y)
    }

    for (const hit of this.lane.between(t - 0.1, t + APPROACH)) {
      if (this.lane.judged.has(hit)) continue
      const p = this.pad(hit.pad)
      const k = Math.max(0, (hit.t - t) / APPROACH)
      g.beginPath()
      g.arc(p.x, p.y, r + k * r * 1.6, 0, Math.PI * 2)
      g.lineWidth = 3
      g.strokeStyle = '#fff'
      g.globalAlpha = Math.min(1, (1 - k) * 2.5)
      g.stroke()
      g.globalAlpha = 1
    }
  }
}
