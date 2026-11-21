/** Blend two #rrggbb colours, k = 0 gives a, 1 gives b. */
export function mix(a: string, b: string, k: number) {
  const pa = parseInt(a.slice(1, 7), 16)
  const pb = parseInt(b.slice(1, 7), 16)
  let out = '#'
  for (const s of [16, 8, 0]) {
    const ca = (pa >> s) & 255
    const cb = (pb >> s) & 255
    out += Math.round(ca + (cb - ca) * k).toString(16).padStart(2, '0')
  }
  return out
}

/** Pooled square particles: tile shards and sparks. Fixed-size typed arrays, no per-frame garbage. */
export class Sparks {
  private x: Float32Array
  private y: Float32Array
  private vx: Float32Array
  private vy: Float32Array
  private life: Float32Array
  private max: Float32Array
  private size: Float32Array
  private col: Uint8Array
  private head = 0

  constructor(private palette: string[], private cap = 256) {
    this.x = new Float32Array(cap)
    this.y = new Float32Array(cap)
    this.vx = new Float32Array(cap)
    this.vy = new Float32Array(cap)
    this.life = new Float32Array(cap)
    this.max = new Float32Array(cap)
    this.size = new Float32Array(cap)
    this.col = new Uint8Array(cap)
  }

  spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, col: number) {
    const i = this.head
    this.head = (i + 1) % this.cap
    this.x[i] = x
    this.y[i] = y
    this.vx[i] = vx
    this.vy[i] = vy
    this.life[i] = life
    this.max[i] = life
    this.size[i] = size
    this.col[i] = col
  }

  /** Break a rect into chunky pixel shards that burst outward, plus a few bright sparks. */
  shatter(x: number, y: number, w: number, h: number, col: number, power: number, sparkCol: number) {
    const cols = 4
    const rows = Math.max(1, Math.min(4, Math.round(h / (w / cols))))
    const cw = w / cols
    const ch = h / rows
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = x + (c + 0.5) * cw
        const cy = y + (r + 0.5) * ch
        const ox = (c + 0.5) / cols - 0.5
        this.spawn(cx, cy, ox * 520 * power + (Math.random() - 0.5) * 80, (-160 - Math.random() * 220) * power, 0.45 + Math.random() * 0.2, Math.min(cw, ch) * 0.55, col)
      }
    }
    const n = Math.round(6 + 8 * power)
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * (0.1 + Math.random() * 0.8)
      const v = (220 + Math.random() * 380) * power
      this.spawn(x + Math.random() * w, y + h, Math.cos(a) * v, Math.sin(a) * v, 0.3 + Math.random() * 0.25, 3 + Math.round(Math.random()) * 2, sparkCol)
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      this.vy[i] += 900 * dt
      this.vx[i] *= 1 - 2 * dt
      this.x[i] += this.vx[i] * dt
      this.y[i] += this.vy[i] * dt
    }
  }

  draw(g: CanvasRenderingContext2D) {
    for (let i = 0; i < this.cap; i++) {
      const life = this.life[i]
      if (life <= 0) continue
      const k = life / this.max[i]
      // Shards shrink in whole pixels as they die, so they stay crisp.
      const s = Math.max(2, Math.round(this.size[i] * (0.4 + 0.6 * k)))
      g.globalAlpha = Math.min(1, k * 1.8)
      g.fillStyle = this.palette[this.col[i]]
      g.fillRect(Math.round(this.x[i] - s / 2), Math.round(this.y[i] - s / 2), s, s)
    }
    g.globalAlpha = 1
  }
}
