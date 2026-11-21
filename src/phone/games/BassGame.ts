import { bassTrackX } from '../../../shared/songs'
import { Game, type GameEnv } from './common'

const LOOKAHEAD = 2
const SHIP_Y = 0.8
const CORE = 0.07
const BAND = 0.15

/** Tilt ship: steer along the scrolling bassline. Drift off it and the bass bends out of tune. */
export class BassGame extends Game {
  private shipX = 0.5
  private tiltX: number | null = null
  private touchX = 0.5
  private touchAt = -Infinity
  private lastT: number | null = null
  private lastBend = 0
  private beat = -1
  private devSum = 0
  private devN = 0
  private bentOff = false

  constructor(env: GameEnv) {
    super(env)
    addEventListener('deviceorientation', this.onTilt)
  }

  private onTilt = (e: DeviceOrientationEvent) => {
    if (e.gamma == null) return
    this.tiltX = Math.max(0, Math.min(1, 0.5 + e.gamma / 60))
  }

  destroy() {
    removeEventListener('deviceorientation', this.onTilt)
  }

  down(x: number) {
    this.touchX = x / this.w
    this.touchAt = performance.now()
  }

  move(x: number) {
    this.down(x)
  }

  update(t: number) {
    const { chart } = this.env
    const dt = this.lastT == null ? 0 : Math.max(0, Math.min(0.1, t - this.lastT))
    this.lastT = t
    const touched = performance.now() - this.touchAt < 1000
    const target = touched || this.tiltX == null ? this.touchX : this.tiltX
    this.shipX += (target - this.shipX) * (1 - Math.exp(-dt * (touched ? 25 : 10)))

    const playing = t >= 0 && t < chart.duration
    // A late player chases the track late too, so compare against where it was inputOffset ago.
    const dev = this.shipX - bassTrackX(chart, t - this.env.inputOffset)
    const now = performance.now()
    if (playing && now - this.lastBend > 66) {
      this.lastBend = now
      this.env.bend(dev)
    } else if (!playing && t > 0 && !this.bentOff) {
      this.bentOff = true
      this.env.bend(0)
    }

    // Grade each beat on the average drift across it.
    const beat = Math.floor(t / chart.beat)
    if (beat !== this.beat) {
      if (this.beat >= 0 && this.devN && this.beat * chart.beat < chart.duration) {
        const avg = this.devSum / this.devN
        this.judge(avg < CORE ? 'perfect' : avg < BAND ? 'good' : 'miss', this.shipX * this.w, this.h * SHIP_Y - 40)
      }
      this.beat = beat
      this.devSum = 0
      this.devN = 0
    }
    if (playing) {
      this.devSum += Math.abs(dev)
      this.devN++
    }
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const { w, h, env } = this
    const color = env.color
    const shipY = h * SHIP_Y
    const timeAt = (y: number) => t + ((shipY - y) / shipY) * LOOKAHEAD

    const edge = (off: number, from: number, to: number) => {
      g.beginPath()
      for (let y = from; y <= to; y += 6) g.lineTo((bassTrackX(env.chart, timeAt(y)) + off) * w, y)
      for (let y = to; y >= from; y -= 6) g.lineTo((bassTrackX(env.chart, timeAt(y)) - off) * w, y)
      g.closePath()
    }

    g.fillStyle = color
    g.globalAlpha = 0.1
    edge(BAND, 0, h)
    g.fill()
    g.globalAlpha = 0.35
    edge(CORE, 0, h)
    g.fill()
    g.globalAlpha = 1

    // Centre line, dashed on the beat so the scroll speed reads.
    g.strokeStyle = color
    g.lineWidth = 2
    g.shadowColor = color
    g.shadowBlur = 10
    g.setLineDash([10, 10])
    g.lineDashOffset = -((t / env.chart.beat) * 20) % 20
    g.beginPath()
    for (let y = 0; y <= h; y += 6) g.lineTo(bassTrackX(env.chart, timeAt(y)) * w, y)
    g.stroke()
    g.setLineDash([])
    g.shadowBlur = 0

    // Ship
    const x = this.shipX * w
    const dev = Math.abs(this.shipX - bassTrackX(env.chart, t - env.inputOffset))
    const ok = dev < CORE ? '#fff' : dev < BAND ? '#ffd23f' : '#ff3b5c'
    g.fillStyle = ok
    g.shadowColor = ok
    g.shadowBlur = 14
    g.beginPath()
    g.moveTo(x, shipY - 22)
    g.lineTo(x + 16, shipY + 14)
    g.lineTo(x, shipY + 6)
    g.lineTo(x - 16, shipY + 14)
    g.closePath()
    g.fill()
    g.shadowBlur = 0
    g.fillStyle = color
    g.fillRect(x - 3, shipY + 12, 6, 6 + Math.random() * 8)
  }
}
