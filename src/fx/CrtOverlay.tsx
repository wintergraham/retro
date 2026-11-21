import { useEffect, useRef } from 'react'
import { Crt, Juice } from './crt'

export interface ScreenFx {
  juice: Juice
  /** 0..1 from team health */
  damage: number
}

/**
 * Fullscreen CRT layer over the host UI: scanlines, vignette, curved bezel, grain, plus glitch and
 * flash pulses from `fx`. Falls back to the CSS scanlines (body::after) when WebGL isn't there.
 * `onShake` gets the screen-shake offset each frame so the caller can move whatever it likes.
 */
export function CrtOverlay({ fx, onShake }: { fx: ScreenFx; onShake?: (x: number, y: number, rot: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const shakeRef = useRef(onShake)
  shakeRef.current = onShake

  useEffect(() => {
    const canvas = ref.current!
    const crt = Crt.create(canvas, 'overlay')
    document.body.classList.toggle('fx-gl', !!crt)
    const resize = () => {
      // Scanlines and grain don't need full resolution on a TV.
      const dpr = Math.min(1, devicePixelRatio || 1)
      canvas.width = Math.round(innerWidth * dpr)
      canvas.height = Math.round(innerHeight * dpr)
    }
    resize()
    addEventListener('resize', resize)
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const s = fx.juice.step(dt, 18)
      shakeRef.current?.(s.x, s.y, s.rot)
      const j = fx.juice
      if (crt) crt.render(now / 1000, { damage: fx.damage, glitch: j.glitch, flash: j.flash, flashColor: j.flashColor })
      // RGB split on the DOM itself while glitching (works with or without WebGL).
      const root = document.querySelector<HTMLElement>('.screen')
      if (root) {
        const g = j.glitch
        root.style.filter = g > 0.05 ? `drop-shadow(${(g * 6).toFixed(1)}px 0 0 rgba(255,40,90,.7)) drop-shadow(${(-g * 6).toFixed(1)}px 0 0 rgba(40,230,255,.7))` : ''
      }
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('resize', resize)
      crt?.destroy()
      document.body.classList.remove('fx-gl')
      const root = document.querySelector<HTMLElement>('.screen')
      if (root) root.style.filter = ''
    }
  }, [fx])

  return <canvas ref={ref} className="crt-overlay" aria-hidden />
}
