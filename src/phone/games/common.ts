import { WINDOW, type Judgement } from '../../../shared/protocol'
import type { Chart } from '../../../shared/songs'

/**
 * Screen juice a game can trigger. Game.judge() already fires the standard set (miss: shake + glitch,
 * perfect: flash), so games only call these directly for extra emphasis. Amounts are 0..1 and stack.
 * Shake is skipped under prefers-reduced-motion; glitch is toned down.
 */
export interface GameFx {
  shake(amount: number): void
  glitch(amount: number): void
  flash(color: string, amount?: number): void
}

export interface GameEnv {
  chart: Chart
  color: string
  /** Seconds this phone's taps land late relative to the host speaker (from calibration). */
  inputOffset: number
  judge(r: Judgement): void
  bend(v: number): void
  sound(r: Judgement): void
  fx: GameFx
}

/** Default FX per judgement; `weight` scales them (e.g. a missed long note might pass 1.5). */
export function judgeFx(fx: GameFx, r: Judgement, color: string, weight = 1) {
  if (r === 'miss') {
    fx.shake(0.55 * weight)
    fx.glitch(0.8 * weight)
  } else if (r === 'perfect') fx.flash(color, 0.45 * weight)
  else fx.flash(color, 0.15 * weight)
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
  big: boolean
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

  /** Report a judgement: sends it to the host, plays the phone SFX, pops the label and fires the screen FX. */
  protected judge(r: Judgement, x: number, y: number, weight = 1) {
    this.env.judge(r)
    this.env.sound(r)
    this.popup(r === 'miss' ? 'MISS!' : r.toUpperCase(), JUDGE_COLOR[r], x, y, r !== 'good')
    judgeFx(this.env.fx, r, this.env.color, weight)
    navigator.vibrate?.(r === 'miss' ? [30, 20, 30] : 12)
  }

  protected popup(text: string, color: string, x: number, y: number, big = false) {
    this.popups.push({ text, color, x, y, born: performance.now(), big })
    if (this.popups.length > 12) this.popups.shift()
  }

  drawFx(g: CanvasRenderingContext2D) {
    const now = performance.now()
    const life = 650
    this.popups = this.popups.filter((p) => now - p.born < life)
    g.save()
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineJoin = 'round'
    for (const p of this.popups) {
      const k = (now - p.born) / life
      // Overshoot pop-in, hold, then drift up and fade.
      const pop = k < 0.15 ? 0.4 + (k / 0.15) * 1.0 : 1.4 - Math.min(1, (k - 0.15) / 0.15) * 0.4
      const size = (p.big ? 18 : 13) * pop
      const x = Math.max(size * 3, Math.min(this.w - size * 3, p.x))
      const y = p.y - 10 - k * 40
      g.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3
      g.font = `${size.toFixed(1)}px ${FONT}`
      g.lineWidth = 4
      g.strokeStyle = '#0b0820'
      g.strokeText(p.text, x, y)
      g.fillStyle = p.color
      g.shadowColor = p.color
      g.shadowBlur = 10
      g.fillText(p.text, x, y)
      g.shadowBlur = 0
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
