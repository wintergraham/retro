import { useEffect, useRef } from 'react'

/** Oscilloscope trace of one synth channel. */
export function Scope({ analyser, color }: { analyser: AnalyserNode; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const g = canvas.getContext('2d')!
    const buf = new Float32Array(analyser.fftSize)
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const w = (canvas.width = canvas.clientWidth * devicePixelRatio)
      const h = (canvas.height = canvas.clientHeight * devicePixelRatio)
      analyser.getFloatTimeDomainData(buf)
      // Trigger on a rising zero crossing so periodic waves stand still.
      let start = 0
      for (let i = 1; i < buf.length / 2; i++) if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break }
      const n = buf.length / 2
      g.clearRect(0, 0, w, h)
      g.strokeStyle = color
      g.lineWidth = 3 * devicePixelRatio
      // LCD ink ghost rather than a neon glow.
      g.shadowColor = 'rgba(38, 51, 28, 0.25)'
      g.shadowOffsetX = 3 * devicePixelRatio
      g.shadowOffsetY = 3 * devicePixelRatio
      g.beginPath()
      for (let i = 0; i < n; i++) {
        const x = (i / n) * w
        const y = h / 2 - buf[start + i] * h * 1.4
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      }
      g.stroke()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [analyser, color])

  // Absolutely placed in a box so the canvas's own pixel size never feeds back into the layout.
  return (
    <div className="scope-box">
      <canvas ref={ref} className="scope" />
    </div>
  )
}
