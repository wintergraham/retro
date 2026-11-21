import type { Judgement } from '../../../shared/protocol'
import type { LeadNote } from '../../../shared/songs'
import { Game, Lane, grade, type GameEnv } from './common'

const FALL = 1.3
const HIT_Y = 0.82
const LANES = 4

/** Piano Tiles: four lanes of falling tiles, tap the lane as a tile reaches the line. */
export class LeadGame extends Game {
  private lane: Lane<LeadNote>
  private result = new Map<LeadNote, Judgement>()
  private flash = [0, 0, 0, 0]

  constructor(env: GameEnv) {
    super(env)
    this.lane = new Lane(env.chart.lead)
  }

  private laneX(i: number) {
    return (i * this.w) / LANES
  }

  update(t: number) {
    this.lane.expire(t, (n) => {
      this.result.set(n, 'miss')
      this.judge('miss', this.laneX(n.lane) + this.w / LANES / 2, this.h * HIT_Y - 30)
    })
  }

  down(x: number, _y: number, t: number) {
    const i = Math.max(0, Math.min(LANES - 1, Math.floor((x / this.w) * LANES)))
    this.flash[i] = performance.now()
    const n = this.lane.nearest(t, (n) => n.lane === i)
    if (!n) return
    const r = grade(t - n.t)
    this.lane.mark(n)
    this.result.set(n, r)
    this.judge(r, this.laneX(i) + this.w / LANES / 2, this.h * HIT_Y - 30)
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const { w, h } = this
    const color = this.env.color
    const hitY = h * HIT_Y
    const lw = w / LANES
    const now = performance.now()
    const px = (dt: number) => hitY - (dt / FALL) * hitY

    // Lanes and tap flashes
    for (let i = 0; i < LANES; i++) {
      const f = Math.max(0, 1 - (now - this.flash[i]) / 180)
      if (f > 0) {
        const grad = g.createLinearGradient(0, hitY, 0, 0)
        grad.addColorStop(0, color)
        grad.addColorStop(1, 'transparent')
        g.globalAlpha = 0.35 * f
        g.fillStyle = grad
        g.fillRect(this.laneX(i), 0, lw, hitY)
        g.globalAlpha = 1
      }
      if (i) {
        g.fillStyle = 'rgba(255,255,255,0.08)'
        g.fillRect(this.laneX(i) - 1, 0, 2, h)
      }
    }

    // Tiles
    for (const n of this.lane.between(t - 2, t + FALL)) {
      const r = this.result.get(n)
      const bottom = px(n.t - t)
      const top = Math.min(bottom - 26, px(n.t + n.d - t) + 4)
      if (top > h) continue
      const x = this.laneX(n.lane) + 5
      const hit = r && r !== 'miss'
      if (hit && t - n.t > 0.25) continue
      g.fillStyle = r === 'miss' ? '#3a3550' : color
      g.globalAlpha = hit ? 1 - (t - n.t) / 0.25 : 1
      g.shadowColor = color
      g.shadowBlur = r ? 0 : 12
      g.fillRect(x, top, lw - 10, bottom - top)
      g.shadowBlur = 0
      g.fillStyle = hit ? '#fff' : 'rgba(0,0,0,0.25)'
      g.fillRect(x, bottom - 8, lw - 10, 8)
      g.globalAlpha = 1
    }

    // Hit line
    g.fillStyle = color
    g.shadowColor = color
    g.shadowBlur = 10
    g.fillRect(0, hitY - 2, w, 4)
    g.shadowBlur = 0
    g.fillStyle = 'rgba(255,255,255,0.05)'
    g.fillRect(0, hitY + 2, w, h - hitY)
  }
}
