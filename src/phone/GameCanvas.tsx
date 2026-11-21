import { useEffect, useRef } from 'react'
import { CHANNEL_INFO, type ChannelId } from '../../shared/protocol'
import type { Chart } from '../../shared/songs'
import type { Net } from '../net'
import { CURVE, Crt, Juice, damageFromHealth, warp } from '../fx/crt'
import type { PhoneSfx } from './sfx'
import type { Game, GameEnv } from './games/common'
import { LeadGame } from './games/LeadGame'
import { BassGame } from './games/BassGame'
import { DrumGame } from './games/DrumGame'

const GAMES: Record<ChannelId, new (env: GameEnv) => Game> = {
  lead: LeadGame,
  bass: BassGame,
  drums: DrumGame,
}

// The 2D game canvas is uploaded to the GPU each frame, so keep it modest on high-DPR phones.
const MAX_DPR = 1.5

interface Props {
  net: Net
  chart: Chart
  startAt: number
  channel: ChannelId
  sfx: PhoneSfx
  inputOffset: number
  /** Latest team health, read every frame (a ref so HUD updates don't restart the game). */
  health: { current: number }
}

export function GameCanvas({ net, chart, startAt, channel, sfx, inputOffset, health }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current!
    const view = ref.current!
    // With WebGL the game draws offscreen and the CRT pass draws the visible canvas; without it, the game draws directly.
    const source = document.createElement('canvas')
    const crt = Crt.create(view, 'source')
    const target = crt ? source : view
    const g = target.getContext('2d')!
    wrap.classList.toggle('no-gl', !crt)

    const juice = new Juice()
    // Judging stops shortly after the last note so stray taps don't count against the team.
    const cutoff = chart.duration + 0.3
    const songTime = () => (net.serverNow() - startAt) / 1000
    const env: GameEnv = {
      chart,
      color: CHANNEL_INFO[channel].color,
      inputOffset,
      judge: (r) => {
        if (songTime() <= cutoff) net.send({ t: 'judge', r })
      },
      bend: (v) => net.send({ t: 'bend', v }),
      sound: (r) => sfx.judge(channel, r),
      fx: {
        shake: (a) => juice.shake(a),
        glitch: (a) => juice.hitGlitch(a),
        flash: (color, a) => juice.hitFlash(color, a),
      },
    }
    const game = new GAMES[channel](env)
    const color = CHANNEL_INFO[channel].color
    let bg: CanvasGradient | null = null

    const resize = () => {
      const dpr = Math.min(MAX_DPR, devicePixelRatio || 1)
      const { width, height } = view.getBoundingClientRect()
      for (const c of new Set([view, target])) {
        c.width = Math.round(width * dpr)
        c.height = Math.round(height * dpr)
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      game.resize(width, height)
      // The CRT pass shows the source canvas opaque, so paint the glow the CSS background gives otherwise.
      bg = g.createRadialGradient(width / 2, height, 0, width / 2, height, Math.max(width, height) * 0.8)
      bg.addColorStop(0, color + '26')
      bg.addColorStop(1, '#0b082000')
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(view)

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const t = songTime()
      if (t <= cutoff) game.update(t)
      if (crt && bg) {
        g.fillStyle = '#0b0820'
        g.fillRect(0, 0, game.w, game.h)
        g.fillStyle = bg
        g.fillRect(0, 0, game.w, game.h)
      } else g.clearRect(0, 0, game.w, game.h)
      game.draw(g, t)
      game.drawFx(g)

      const damage = damageFromHealth(health.current)
      const s = juice.step(dt, 10)
      wrap.style.transform = s.x || s.y ? `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) rotate(${s.rot.toFixed(2)}deg)` : ''
      if (crt) crt.render(now / 1000, { damage, glitch: juice.glitch, flash: juice.flash, flashColor: juice.flashColor }, source)
      else {
        wrap.style.setProperty('--glitch', juice.glitch.toFixed(2))
        wrap.classList.toggle('glitching', juice.glitch > 0.2)
      }
    }
    raf = requestAnimationFrame(loop)

    // event.timeStamp shares performance.now()'s clock, so taps are timed when they happened,
    // not when the handler got around to running; calibration removes this phone's own lag.
    // With the CRT on, a tap lands on the curved image, so map it back through the same warp.
    const pointer = (fn: 'down' | 'move' | 'up') => (e: PointerEvent) => {
      e.preventDefault()
      const ts = e.timeStamp > 0 ? e.timeStamp : performance.now()
      const t = (ts + net.offset - startAt) / 1000 - inputOffset
      if (t > cutoff) return
      const r = view.getBoundingClientRect()
      if (fn === 'down') view.setPointerCapture?.(e.pointerId)
      let px = (e.clientX - r.left) / r.width
      let py = (e.clientY - r.top) / r.height
      if (crt) [px, py] = warp(px, py, CURVE.source)
      game[fn](px * game.w, py * game.h, t)
    }
    const down = pointer('down')
    const move = pointer('move')
    const up = pointer('up')
    view.addEventListener('pointerdown', down)
    view.addEventListener('pointermove', move)
    view.addEventListener('pointerup', up)
    view.addEventListener('pointercancel', up)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      view.removeEventListener('pointerdown', down)
      view.removeEventListener('pointermove', move)
      view.removeEventListener('pointerup', up)
      view.removeEventListener('pointercancel', up)
      game.destroy()
      crt?.destroy()
    }
  }, [net, chart, startAt, channel, sfx, inputOffset, health])

  return (
    <div ref={wrapRef} className="game-wrap">
      <canvas ref={ref} className="game-canvas" style={{ touchAction: 'none' }} />
    </div>
  )
}
