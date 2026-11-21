import { FONT, Game, type GameEnv } from './common'

const PERFECT_PART = 0.6

/** Connect the dots: swipe through this bar's numbered dots in order before the bar ends. */
export class ArpGame extends Game {
  private bar = -1
  private progress = 0
  private done = false
  private lastCell = -1
  private active = false
  private finger = { x: 0, y: 0 }
  private shake = 0

  constructor(env: GameEnv) {
    super(env)
  }

  private get grid() {
    const size = Math.min(this.w * 0.84, this.h * 0.58)
    return { size, x: (this.w - size) / 2, y: this.h * 0.56 - size / 2, step: size / 3 }
  }

  private cellPos(c: number) {
    const { x, y, step } = this.grid
    return { x: x + step * ((c % 3) + 0.5), y: y + step * (Math.floor(c / 3) + 0.5) }
  }

  private cellAt(px: number, py: number) {
    const { step } = this.grid
    for (let c = 0; c < 9; c++) {
      const p = this.cellPos(c)
      if (Math.hypot(px - p.x, py - p.y) < step * 0.38) return c
    }
    return -1
  }

  update(t: number) {
    const { chart } = this.env
    const bar = Math.floor(t / chart.bar)
    while (this.bar < bar) {
      if (this.bar >= 0 && this.bar < chart.bars && !this.done) {
        const mid = this.cellPos(4)
        this.judge('miss', mid.x, this.grid.y - 16)
      }
      this.bar++
      this.progress = 0
      this.done = false
      this.lastCell = -1
    }
  }

  down(x: number, y: number, t: number) {
    this.active = true
    this.touch(x, y, t)
  }

  move(x: number, y: number, t: number) {
    if (this.active) this.touch(x, y, t)
  }

  up() {
    this.active = false
  }

  private touch(x: number, y: number, t: number) {
    this.finger = { x, y }
    const { chart } = this.env
    const ab = chart.arpBars[this.bar]
    if (!ab || this.done) return
    const cell = this.cellAt(x, y)
    if (cell < 0 || cell === this.lastCell) return
    this.lastCell = cell
    const pattern = ab.pattern
    if (cell === pattern[this.progress]) this.progress++
    else {
      this.progress = cell === pattern[0] ? 1 : 0
      this.shake = performance.now()
      navigator.vibrate?.([8, 30, 8])
    }
    if (this.progress === pattern.length) {
      this.done = true
      const into = (t - ab.t) / ab.d
      const p = this.cellPos(cell)
      this.judge(into <= PERFECT_PART ? 'perfect' : 'good', p.x, p.y - 30)
    }
  }

  draw(g: CanvasRenderingContext2D, t: number) {
    const { chart, color } = this.env
    const { w } = this
    const grid = this.grid
    const now = performance.now()
    const cur = chart.arpBars[this.bar]
    const next = chart.arpBars[this.bar + 1]
    const shake = Math.max(0, 1 - (now - this.shake) / 250)
    g.save()
    g.translate(Math.sin(now / 20) * 6 * shake, 0)

    // Bar timer with the perfect cutoff marked.
    if (cur) {
      const k = Math.max(0, Math.min(1, (t - cur.t) / cur.d))
      const bx = grid.x
      const by = grid.y - 44
      g.fillStyle = 'rgba(255,255,255,0.1)'
      g.fillRect(bx, by, grid.size, 8)
      g.fillStyle = this.done ? 'rgba(255,255,255,0.35)' : k <= PERFECT_PART ? color : '#ffd23f'
      g.fillRect(bx, by, grid.size * (1 - k), 8)
      g.fillStyle = '#fff'
      g.fillRect(bx + grid.size * (1 - PERFECT_PART) - 1, by - 3, 2, 14)
    }

    const pattern = cur?.pattern ?? []
    const dim = this.done ? 0.35 : 1

    // Lines between connected dots, plus a rubber band to the finger.
    if (this.progress > 0) {
      g.strokeStyle = color
      g.lineWidth = 8
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.globalAlpha = dim
      g.shadowColor = color
      g.shadowBlur = 12
      g.beginPath()
      for (let i = 0; i < this.progress; i++) {
        const p = this.cellPos(pattern[i])
        g.lineTo(p.x, p.y)
      }
      if (this.active && !this.done) g.lineTo(this.finger.x, this.finger.y)
      g.stroke()
      g.shadowBlur = 0
      g.globalAlpha = 1
    }

    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (let c = 0; c < 9; c++) {
      const p = this.cellPos(c)
      const order = pattern.indexOf(c)
      const r = grid.step * 0.2
      g.beginPath()
      g.arc(p.x, p.y, order >= 0 ? r : r * 0.4, 0, Math.PI * 2)
      if (order < 0) {
        g.fillStyle = 'rgba(255,255,255,0.15)'
        g.fill()
        continue
      }
      const connected = order < this.progress
      const isNext = order === this.progress && !this.done
      g.globalAlpha = dim
      g.fillStyle = connected ? color : '#0b0820'
      g.fill()
      g.lineWidth = isNext ? 4 + Math.sin(now / 90) * 1.5 : 3
      g.strokeStyle = isNext ? '#fff' : color
      g.stroke()
      g.fillStyle = connected ? '#0b0820' : '#fff'
      g.font = `${Math.round(r * 0.8)}px ${FONT}`
      g.fillText(String(order + 1), p.x, p.y + 1)
      g.globalAlpha = 1
    }
    g.restore()

    // Small faint preview of the next bar's shape.
    if (next) {
      const s = Math.min(60, w * 0.18, grid.y - 70)
      const ox = w - s - 14
      const oy = 16
      if (s > 24) {
        g.globalAlpha = 0.4
        g.fillStyle = '#fff'
        g.font = `8px ${FONT}`
        g.textAlign = 'left'
        g.fillText('NEXT', ox, oy - 2)
        const at = (c: number) => ({ x: ox + (s / 3) * ((c % 3) + 0.5), y: oy + 6 + (s / 3) * (Math.floor(c / 3) + 0.5) })
        g.strokeStyle = color
        g.lineWidth = 2
        g.beginPath()
        for (const c of next.pattern) {
          const p = at(c)
          g.lineTo(p.x, p.y)
        }
        g.stroke()
        for (let c = 0; c < 9; c++) {
          const p = at(c)
          g.fillStyle = c === next.pattern[0] ? '#fff' : next.pattern.includes(c) ? color : 'rgba(255,255,255,0.4)'
          g.fillRect(p.x - 2, p.y - 2, 4, 4)
        }
        g.globalAlpha = 1
      }
    }
  }
}
