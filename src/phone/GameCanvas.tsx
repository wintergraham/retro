import { useEffect, useRef } from 'react'
import { CHANNEL_INFO, type ChannelId } from '../../shared/protocol'
import type { Chart } from '../../shared/songs'
import type { Net } from '../net'
import type { PhoneSfx } from './sfx'
import type { Game, GameEnv } from './games/common'
import { LeadGame } from './games/LeadGame'
import { BassGame } from './games/BassGame'
import { DrumGame } from './games/DrumGame'
import { ArpGame } from './games/ArpGame'

const GAMES: Record<ChannelId, new (env: GameEnv) => Game> = {
  lead: LeadGame,
  bass: BassGame,
  drums: DrumGame,
  arp: ArpGame,
}

interface Props {
  net: Net
  chart: Chart
  startAt: number
  channel: ChannelId
  sfx: PhoneSfx
  inputOffset: number
}

export function GameCanvas({ net, chart, startAt, channel, sfx, inputOffset }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const g = canvas.getContext('2d')!
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
    }
    const game = new GAMES[channel](env)

    const resize = () => {
      const dpr = devicePixelRatio || 1
      const { width, height } = canvas.getBoundingClientRect()
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      game.resize(width, height)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const t = songTime()
      if (t <= cutoff) game.update(t)
      g.clearRect(0, 0, game.w, game.h)
      game.draw(g, t)
      game.drawFx(g)
    }
    raf = requestAnimationFrame(loop)

    // event.timeStamp shares performance.now()'s clock, so taps are timed when they happened,
    // not when the handler got around to running; calibration removes this phone's own lag.
    const pointer = (fn: 'down' | 'move' | 'up') => (e: PointerEvent) => {
      e.preventDefault()
      const ts = e.timeStamp > 0 ? e.timeStamp : performance.now()
      const t = (ts + net.offset - startAt) / 1000 - inputOffset
      if (t > cutoff) return
      const r = canvas.getBoundingClientRect()
      if (fn === 'down') canvas.setPointerCapture?.(e.pointerId)
      game[fn](e.clientX - r.left, e.clientY - r.top, t)
    }
    const down = pointer('down')
    const move = pointer('move')
    const up = pointer('up')
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      game.destroy()
    }
  }, [net, chart, startAt, channel, sfx, inputOffset])

  return <canvas ref={ref} className="game-canvas" style={{ touchAction: 'none' }} />
}
