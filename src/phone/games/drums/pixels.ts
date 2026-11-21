// Chunky pixel-art primitives on a fixed block grid, batched into one path per call so a frame stays cheap.

const snap = (v: number, s: number) => Math.round(v / s) * s

/** Adds an ellipse outline of s-sized blocks to the current path. `gap` drops every gap-th block (dotted). */
export function ringPath(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, s: number, gap = 0) {
  const n = Math.max(12, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / (s * 0.9)))
  for (let i = 0; i < n; i++) {
    if (gap && i % gap === gap - 1) continue
    const a = (i / n) * Math.PI * 2
    g.rect(snap(cx + Math.cos(a) * rx, s) - s / 2, snap(cy + Math.sin(a) * ry, s) - s / 2, s, s)
  }
}

export function ring(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, s: number, color: string, thick = 1, gap = 0) {
  g.beginPath()
  for (let i = 0; i < thick; i++) ringPath(g, cx, cy, rx - i * s, ry - i * s, s, gap)
  g.fillStyle = color
  g.fill()
}

/** Filled ellipse drawn as one rect per s-high row. */
export function disc(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, s: number, color: string) {
  g.beginPath()
  const rows = Math.ceil(ry / s)
  for (let j = -rows; j <= rows; j++) {
    const y = j * s
    const k = 1 - (y * y) / (ry * ry)
    if (k <= 0) continue
    const hw = snap(rx * Math.sqrt(k), s)
    g.rect(snap(cx, s) - hw, snap(cy, s) + y - s / 2, hw * 2, s)
  }
  g.fillStyle = color
  g.fill()
}

interface Bit {
  x: number
  y: number
  vx: number
  vy: number
  born: number
  life: number
  size: number
  grav: number
  color: string
}

interface Wave {
  x: number
  y: number
  r0: number
  r1: number
  born: number
  life: number
  color: string
}

/** Square debris and expanding block shockwaves. */
export class Pixels {
  private bits: Bit[] = []
  private waves: Wave[] = []

  burst(x: number, y: number, n: number, color: string, speed: number, r = 0) {
    const now = performance.now()
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = speed * (0.5 + Math.random() * 0.7)
      this.bits.push({
        x: x + Math.cos(a) * r,
        y: y + Math.sin(a) * r,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - speed * 0.4,
        born: now,
        life: 380 + Math.random() * 260,
        size: Math.random() < 0.3 ? 6 : 4,
        grav: 520,
        color,
      })
    }
    if (this.bits.length > 140) this.bits.splice(0, this.bits.length - 140)
  }

  ember(x: number, y: number, color: string) {
    this.bits.push({ x, y, vx: (Math.random() - 0.5) * 30, vy: -60 - Math.random() * 90, born: performance.now(), life: 700, size: 3, grav: -40, color })
  }

  wave(x: number, y: number, r0: number, r1: number, color: string, life = 320) {
    this.waves.push({ x, y, r0, r1, born: performance.now(), life, color })
    if (this.waves.length > 12) this.waves.shift()
  }

  draw(g: CanvasRenderingContext2D, dt: number) {
    const now = performance.now()
    this.waves = this.waves.filter((w) => now - w.born < w.life)
    for (const w of this.waves) {
      const k = (now - w.born) / w.life
      const e = 1 - (1 - k) * (1 - k)
      g.globalAlpha = 1 - k
      ring(g, w.x, w.y, w.r0 + (w.r1 - w.r0) * e, w.r0 + (w.r1 - w.r0) * e, 4, w.color, k < 0.4 ? 2 : 1, k > 0.5 ? 2 : 0)
    }
    this.bits = this.bits.filter((b) => now - b.born < b.life)
    for (const b of this.bits) {
      b.vy += b.grav * dt
      b.x += b.vx * dt
      b.y += b.vy * dt
      g.globalAlpha = Math.min(1, 2 * (1 - (now - b.born) / b.life))
      g.fillStyle = b.color
      g.fillRect(Math.round(b.x / 2) * 2, Math.round(b.y / 2) * 2, b.size, b.size)
    }
    g.globalAlpha = 1
  }
}
