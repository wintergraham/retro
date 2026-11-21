const D2R = Math.PI / 180
/** Degrees of tilt from neutral that take the ship from the centre to a screen edge. */
const RANGE = 22
/** Sensor jitter below this many degrees is ignored. */
const DEADZONE = 1.2
/** Song-time window (seconds) whose average angle becomes neutral: the opaque part of the countdown. */
const CALIB_FROM = -3
const CALIB_TO = -1

/** One-euro filter: heavy smoothing when the phone is still, light when it's moving fast. */
class OneEuro {
  private x: number | null = null
  private dx = 0
  private last = 0

  constructor(private minCut = 1.5, private beta = 0.05, private dCut = 1) {}

  filter(v: number, ms: number) {
    if (this.x == null) {
      this.last = ms
      return (this.x = v)
    }
    const dt = Math.max(0.001, Math.min(0.2, (ms - this.last) / 1000))
    this.last = ms
    const a = (cut: number) => 1 / (1 + 1 / (2 * Math.PI * cut * dt))
    this.dx += a(this.dCut) * ((v - this.x) / dt - this.dx)
    this.x += a(this.minCut + this.beta * Math.abs(this.dx)) * (v - this.x)
    return this.x
  }
}

/**
 * Left/right steering from deviceorientation. The angle is how far the screen's x axis dips
 * towards the ground, so it works whether the phone is held flat, upright or anywhere between
 * (raw gamma goes haywire near upright). Neutral auto-calibrates during the countdown.
 */
export class Tilt {
  /** Filtered steering angle in degrees, positive = right side down. */
  angle: number | null = null
  neutral = 0
  calibrated = false
  private lastEvent = -Infinity
  private sum = 0
  private n = 0
  private filter = new OneEuro()

  constructor() {
    addEventListener('deviceorientation', this.onEvent)
  }

  destroy() {
    removeEventListener('deviceorientation', this.onEvent)
  }

  private onEvent = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return
    const b = e.beta * D2R
    const g = e.gamma * D2R
    const turn = screen.orientation?.angle ?? 0
    const side = turn === 90 ? -Math.sin(b) : turn === 270 ? Math.sin(b) : (turn === 180 ? -1 : 1) * Math.cos(b) * Math.sin(g)
    const deg = Math.asin(Math.max(-1, Math.min(1, side))) / D2R
    this.angle = this.filter.filter(deg, e.timeStamp || performance.now())
    this.lastEvent = performance.now()
  }

  get active() {
    return this.angle != null && performance.now() - this.lastEvent < 1500
  }

  /** Feed song time each frame; returns true on the frame neutral gets locked in. */
  calibrate(t: number) {
    if (this.calibrated || this.angle == null) return false
    if (t >= CALIB_FROM && t < CALIB_TO) {
      this.sum += this.angle
      this.n++
      return false
    }
    if (t < CALIB_TO) return false
    // Joined late or tilt only just started: take where the phone is now.
    const mean = this.n ? this.sum / this.n : this.angle
    this.neutral = Math.max(-30, Math.min(30, mean))
    this.calibrated = true
    return true
  }

  /** Target ship x in 0..1, or null without a live sensor. */
  x(): number | null {
    if (!this.active || this.angle == null) return null
    const a = this.angle - this.neutral
    const d = Math.sign(a) * Math.max(0, Math.abs(a) - DEADZONE)
    return 0.5 + Math.max(-1, Math.min(1, d / RANGE)) * 0.5
  }
}
