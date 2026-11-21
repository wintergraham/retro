import { WINDOW, type Judgement } from '../../../shared/protocol'
import type { Chart } from '../../../shared/songs'

export interface GameEnv {
  chart: Chart
  color: string
  /** Seconds this phone's taps land late relative to the host speaker (from calibration). */
  inputOffset: number
  judge(r: Judgement): void
  bend(v: number): void
  sound(r: Judgement): void
}

export const JUDGE_COLOR: Record<Judgement, string> = { perfect: '#5dff7a', good: '#ffd23f', miss: '#ff3b5c' }

export const FONT = '"Press Start 2P", monospace'

export function grade(delta: number): Judgement {
  const d = Math.abs(delta)
  return d <= WINDOW.perfect ? 'perfect' : d <= WINDOW.good ? 'good' : 'miss'
}

interface Popup {
  text: string
  color: string
  x: number
  y: number
  born: number
}

export abstract class Game {
  w = 0
  h = 0
  private popups: Popup[] = []

  constructor(protected env: GameEnv) {}

  resize(w: number, h: number) {
    this.w = w
    this.h = h
  }

  abstract update(t: number): void
  abstract draw(g: CanvasRenderingContext2D, t: number): void
  down(_x: number, _y: number, _t: number) {}
  move(_x: number, _y: number, _t: number) {}
  up(_x: number, _y: number, _t: number) {}
  destroy() {}

  protected judge(r: Judgement, x: number, y: number) {
    this.env.judge(r)
    this.env.sound(r)
    this.popup(r.toUpperCase(), JUDGE_COLOR[r], x, y)
    if (r !== 'miss') navigator.vibrate?.(12)
  }

  protected popup(text: string, color: string, x: number, y: number) {
    this.popups.push({ text, color, x, y, born: performance.now() })
    if (this.popups.length > 12) this.popups.shift()
  }

  drawFx(g: CanvasRenderingContext2D) {
    const now = performance.now()
    this.popups = this.popups.filter((p) => now - p.born < 600)
    g.save()
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = `12px ${FONT}`
    for (const p of this.popups) {
      const k = (now - p.born) / 600
      g.globalAlpha = 1 - k * k
      g.fillStyle = p.color
      g.shadowColor = p.color
      g.shadowBlur = 8
      g.fillText(p.text, p.x, p.y - k * 36)
    }
    g.restore()
  }
}

/** A time-sorted list of things to hit, tracking which have been judged. */
export class Lane<T extends { t: number }> {
  private next = 0
  readonly judged = new Set<T>()

  constructor(readonly items: T[]) {}

  /** Auto-miss every unjudged item that has slipped out of the window. */
  expire(t: number, onMiss: (item: T) => void) {
    while (this.next < this.items.length && this.items[this.next].t < t - WINDOW.good) {
      const item = this.items[this.next++]
      if (!this.judged.has(item)) {
        this.judged.add(item)
        onMiss(item)
      }
    }
  }

  /** Closest unjudged item within the good window that passes `match`, or null. */
  nearest(t: number, match: (item: T) => boolean = () => true): T | null {
    let best: T | null = null
    for (let i = this.next; i < this.items.length; i++) {
      const item = this.items[i]
      if (item.t > t + WINDOW.good) break
      if (this.judged.has(item) || !match(item) || Math.abs(item.t - t) > WINDOW.good) continue
      if (!best || Math.abs(item.t - t) < Math.abs(best.t - t)) best = item
    }
    return best
  }

  mark(item: T) {
    this.judged.add(item)
  }

  /** Items with t in [from, to], for drawing. */
  between(from: number, to: number): T[] {
    const out: T[] = []
    for (const item of this.items) {
      if (item.t > to) break
      if (item.t >= from) out.push(item)
    }
    return out
  }
}
