import { useEffect, useRef } from 'react'
import { CHANNEL_INFO, type ChannelId, type Judgement } from '../../shared/protocol'
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
  /** Filled in with a handler for the hardware keys under the screen (key index, pressed, event timeStamp). */
  keys?: { current: ((i: number, down: boolean, timeStamp: number) => void) | null }
  /** Called every frame with what the LCD around the game shows. */
  readout?: (r: Readout) => void
}

export interface Readout {
  t: number
  last: Judgement | null
  lastAt: number
  /** Bass only: how far off the bassline the ship is, -1..1. */
  drift: number
}

export function GameCanvas({ net, chart, startAt, channel, sfx, inputOffset, health, keys, readout }: Props) {
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
    // Judging stops shortly after the last note so stray taps don't count against the team. Taps are
    // offset-corrected; the chart clock runs inputOffset longer so a late phone still judges its last notes.
    const cutoff = chart.duration + 0.3
    const runUntil = cutoff + Math.max(0, inputOffset)
    const songTime = () => (net.serverNow() - startAt) / 1000
    const read: Readout = { t: 0, last: null, lastAt: 0, drift: 0 }
    const env: GameEnv = {
      chart,
      color: CHANNEL_INFO[channel].color,
      inputOffset,
      startT: songTime(),
      judge: (r) => {
        read.last = r
        read.lastAt = performance.now()
        if (songTime() <= runUntil) net.send({ t: 'judge', r })
      },
      bend: (v) => {
        read.drift = v
        net.send({ t: 'bend', v })
      },
      voice: (v) => ('pad' in v ? sfx.drum(v.pad) : sfx.note(v.midi, v.d)),
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
    let bassIdx = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const t = songTime()
      if (t <= runUntil) game.update(t)
      if (channel === 'bass') {
        // The bass phone hums its own line, bending as the ship drifts off it.
        while (bassIdx < chart.bass.length && chart.bass[bassIdx].t + chart.bass[bassIdx].d < t) bassIdx++
        const n = chart.bass[bassIdx]
        sfx.bassHum(t >= 0 && t <= chart.duration && n && n.t <= t ? n.midi : null, read.drift)
      }
      read.t = t
      readout?.(read)
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
      if (fn === 'down') {
        try {
          view.setPointerCapture(e.pointerId)
        } catch {}
      }
      let px = (e.clientX - r.left) / r.width
      let py = (e.clientY - r.top) / r.height
      if (crt) [px, py] = warp(px, py, CURVE.source)
      game[fn](px * game.w, py * game.h, t)
    }
    if (keys)
      keys.current = (i, isDown, ts) => {
        const t = ((ts > 0 ? ts : performance.now()) + net.offset - startAt) / 1000 - inputOffset
        const pos = game.keyPos(i)
        if (!pos || t > cutoff) return
        if (isDown) game.down(pos[0], pos[1], t)
        else game.up(pos[0], pos[1], t)
      }
    const down = pointer('down')
    const move = pointer('move')
    const up = pointer('up')
    // A phone that rejoined by itself after a reload hasn't had a gesture yet; the first tap unlocks its SFX
    // (iOS only counts touchend as a gesture for audio, Android and desktop take pointerup).
    const unlock = () => sfx.unlock()
    view.addEventListener('touchend', unlock)
    view.addEventListener('pointerup', unlock)
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
      view.removeEventListener('touchend', unlock)
      view.removeEventListener('pointerup', unlock)
      game.destroy()
      crt?.destroy()
      sfx.humStop()
      if (keys) keys.current = null
    }
  }, [net, chart, startAt, channel, sfx, inputOffset, health, keys])

  return (
    <div ref={wrapRef} className="game-wrap">
      <canvas ref={ref} className="game-canvas" style={{ touchAction: 'none' }} />
    </div>
  )
}
