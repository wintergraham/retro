import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import {
  ARP_INFO,
  CALIB,
  CHANNELS,
  CHANNEL_INFO,
  CHANNEL_STEPS,
  type ChannelId,
  type GameResults,
  type Judgement,
  type PlayerInfo,
} from '../../shared/protocol'
import { SONGS, songById, type Chart } from '../../shared/songs'
import { Net } from '../net'
import { liveRoast } from '../../shared/roasts'
import { ChipSynth } from './audio'
import { Scoreboard } from './scoring'
import { Scope } from './Scope'
import { HealthBar, Results } from '../ui'
import { CrtOverlay, type ScreenFx } from '../fx/CrtOverlay'
import { Juice, damageFromHealth } from '../fx/crt'

type Phase = 'lobby' | 'ready' | 'playing' | 'results'

interface Live {
  chart: Chart
  board: Scoreboard
  roster: PlayerInfo[]
  lastJudge: Partial<Record<ChannelId, { r: Judgement; at: number }>>
  /** Per-card shake/flash. */
  cards: Record<ChannelId, Juice>
  weakest: string | null
  roast: { playerId: string; text: string; at: number } | null
  done: boolean
}

const newCards = () => ({ lead: new Juice(), bass: new Juice(), drums: new Juice() }) as Record<ChannelId, Juice>

export function HostApp() {
  const [code, setCode] = useState('')
  const [players, setPlayers] = useState<PlayerInfo[]>([])
  const [phase, setPhase] = useState<Phase>('lobby')
  const [songId, setSongId] = useState(SONGS[0].id)
  const [results, setResults] = useState<GameResults | null>(null)
  const [joinUrl, setJoinUrl] = useState('')
  const [qr, setQr] = useState('')
  const [, setFrame] = useState(0)
  const [ready, setReady] = useState<string[]>([])
  const screenRef = useRef<HTMLDivElement>(null)
  const fx = useMemo<ScreenFx>(() => ({ juice: new Juice(), damage: 0 }), [])

  const synth = useMemo(() => new ChipSynth(), [])
  const net = useMemo(() => new Net(() => net.send({ t: 'host:create' })), [])
  const live = useRef<Live | null>(null)
  const playersRef = useRef(players)
  playersRef.current = players

  useEffect(() => () => net.close(), [net])

  const [speakerDelay, setSpeakerDelay] = useState(() => Number(readStore('chip-squad:speaker-delay')) || 0)
  useEffect(() => {
    synth.extraLatency = speakerDelay / 1000
    writeStore('chip-squad:speaker-delay', String(speakerDelay))
  }, [speakerDelay])

  // Browsers keep audio suspended until a gesture; any click in the lobby wakes it for calibration clicks.
  const [audioOn, setAudioOn] = useState(synth.ctx.state === 'running')
  useEffect(() => {
    const wake = () => void synth.ctx.resume().then(() => setAudioOn(true))
    addEventListener('pointerdown', wake)
    addEventListener('keydown', wake)
    return () => {
      removeEventListener('pointerdown', wake)
      removeEventListener('keydown', wake)
    }
  }, [synth])

  // Join link: swap localhost for the LAN address so phones can reach it.
  useEffect(() => {
    if (!code) return
    ;(async () => {
      let origin = location.origin
      if (['localhost', '127.0.0.1'].includes(location.hostname)) {
        const info = await fetch('/api/info').then((r) => r.json()).catch(() => ({ lan: [] }))
        // The plain-http dev host (npm run dev:host) still sends phones to the HTTPS server they need for tilt.
        const phonePort = import.meta.env.VITE_PHONE_PORT || location.port
        const proto = import.meta.env.VITE_PHONE_PORT ? 'https:' : location.protocol
        if (info.lan[0]) origin = `${proto}//${info.lan[0]}${phonePort ? `:${phonePort}` : ''}`
      }
      const url = `${origin}/play?room=${code}`
      setJoinUrl(url)
      setQr(await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#0b0820', light: '#ffffff' } }))
    })()
  }, [code])

  const finish = (cleared: boolean) => {
    const g = live.current
    if (!g || g.done) return
    g.done = true
    if (cleared) {
      synth.stop()
      synth.fanfare()
    } else synth.gameOver()
    const res = g.board.results(g.chart.id, cleared)
    setResults(res)
    net.send({ t: 'host:end', results: res })
    setTimeout(() => setPhase('results'), cleared ? 900 : 1800)
  }

  useEffect(
    () =>
      net.on((msg) => {
        switch (msg.t) {
          case 'room':
            return setCode(msg.code)
          case 'players':
            return setPlayers(msg.players)
          case 'ready':
            setSongId(msg.songId)
            setReady(msg.ready)
            return setPhase('ready')
          case 'start': {
            const chart = songById(msg.songId)
            const roster = playersRef.current.filter((p) => p.channel)
            live.current = { chart, board: new Scoreboard(roster), roster, lastJudge: {}, cards: newCards(), weakest: null, roast: null, done: false }
            synth.play(chart, (msg.startAt - net.serverNow()) / 1000)
            setResults(null)
            return setPhase('playing')
          }
          case 'judge': {
            const g = live.current
            const p = g?.roster.find((x) => x.id === msg.playerId)
            if (!g || !p?.channel || g.done) return
            const songTime = synth.songTime()
            g.board.judge(p.id, msg.r, songTime)
            g.lastJudge[p.channel] = { r: msg.r, at: performance.now() }
            const card = g.cards[p.channel]
            const color = CHANNEL_INFO[p.channel].color
            if (msg.r === 'miss') {
              synth.miss(p.channel, g.chart.beat)
              // Misses in a row hit harder; at low HP the whole screen goes too.
              const streak = g.board.stats.get(p.id)?.missStreak ?? 1
              const severity = Math.min(1, 0.45 + streak * 0.12 + damageFromHealth(g.board.health) * 0.3)
              card.shake(severity)
              card.hitGlitch(1)
              fx.juice.hitGlitch(0.15 + severity * 0.25)
              if (g.board.health < 40) fx.juice.shake(severity * 0.6)
            } else if (msg.r === 'perfect') {
              card.hitFlash(color, 0.9)
              fx.juice.hitFlash(color, 0.12)
            } else card.hitFlash(color, 0.35)
            return
          }
          case 'calib':
            if (live.current && !live.current.done) return
            return synth.clicks((msg.startAt - net.serverNow()) / 1000, CALIB.clicks, CALIB.interval)
          case 'bend': {
            const p = live.current?.roster.find((x) => x.id === msg.playerId)
            if (p?.channel !== 'bass') return
            return synth.bassDrift(msg.v)
          }
        }
      }),
    [net, synth, fx],
  )

  // Game loop: HUD redraw, health sync to phones, win/lose checks.
  useEffect(() => {
    if (phase !== 'playing') return
    let raf = 0
    let lastHud = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const g = live.current
      if (!g) return
      setFrame((f) => f + 1)
      const songTime = synth.songTime()
      if (!g.done) {
        synth.setHealth(g.board.health)
        fx.damage = damageFromHealth(g.board.health)
      }
      g.weakest = g.board.weakest(songTime)
      // Fresh roast whenever the weakest link changes, and every few seconds if they stay there.
      if (!g.weakest) g.roast = null
      else if (g.roast?.playerId !== g.weakest || now - g.roast.at > 6000) {
        const p = g.roster.find((x) => x.id === g.weakest)
        if (p?.channel) g.roast = { playerId: p.id, text: liveRoast(p.channel), at: now }
      }
      if (now - lastHud > 200) {
        lastHud = now
        net.send({ t: 'host:hud', health: g.board.health, combo: g.board.teamCombo, weakest: g.weakest, roast: g.roast?.text ?? null })
      }
      if (g.board.health <= 0) finish(false)
      else if (synth.songTime() > g.chart.duration + 0.3) finish(true)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  // Leaving play: clean picture again.
  useEffect(() => {
    if (phase !== 'playing') fx.damage = 0
  }, [phase])

  const toReady = async () => {
    await synth.ctx.resume()
    net.send({ t: 'host:ready', songId })
  }

  const startAnyway = async () => {
    await synth.ctx.resume()
    net.send({ t: 'host:start', songId })
  }

  const backToLobby = () => {
    live.current = null
    setPhase('lobby')
    net.send({ t: 'host:lobby' })
  }

  const shake = (x: number, y: number, rot: number) => {
    const el = screenRef.current
    if (el) el.style.transform = x || y ? `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${rot.toFixed(2)}deg)` : ''
  }
  const wrap = (body: React.ReactNode) => (
    <>
      {body}
      <CrtOverlay fx={fx} onShake={shake} />
    </>
  )

  if (phase === 'results' && results) {
    return wrap(
      <div className="screen host" ref={screenRef}>
        <Results results={results} />
        <button className="btn big" onClick={backToLobby}>PLAY AGAIN</button>
      </div>,
    )
  }

  if (phase === 'ready') {
    const song = songById(songId)
    const seated = players.filter((p) => p.channel && p.connected)
    const waiting = seated.filter((p) => !ready.includes(p.id)).length
    return wrap(
      <div className="screen host ready-up" ref={screenRef}>
        <div className="dim small">NEXT UP</div>
        <h2 className="ready-title">{song.title}</h2>
        <div className="dim small">{song.difficulty} · {song.bpm} BPM</div>
        <div className="channels">
          {CHANNELS.map((ch) => {
            const info = CHANNEL_INFO[ch]
            const p = players.find((x) => x.channel === ch)
            const ok = p && ready.includes(p.id)
            return (
              <div key={ch} className={`channel-card ready-card ${ok ? 'is-ready' : ''}`} style={{ '--c': info.color } as React.CSSProperties}>
                <div className="channel-head">
                  <span>{info.name}</span>
                  <span className="dim">{info.game}</span>
                </div>
                <ol className="steps">
                  {CHANNEL_STEPS[ch].map((s) => <li key={s}>{s}</li>)}
                </ol>
                <div className="channel-foot">
                  <span>{p ? p.name : 'CPU'}</span>
                  <span className={`ready-flag ${ok ? 'on' : ''}`}>{!p ? 'AUTO' : ok ? 'READY ✓' : 'WAITING…'}</span>
                </div>
              </div>
            )
          })}
        </div>
        <p className="dim small">{waiting ? `WAITING FOR ${waiting} PLAYER${waiting > 1 ? 'S' : ''} TO HIT READY` : 'EVERYONE READY'}</p>
        <div className="row">
          <button className="btn" onClick={backToLobby}>BACK</button>
          <button className="btn big" onClick={startAnyway}>START ANYWAY</button>
        </div>
      </div>,
    )
  }

  if (phase === 'playing' && live.current) {
    const g = live.current
    const t = synth.songTime()
    const now = performance.now()
    return wrap(
      <div className="screen host playing" ref={screenRef}>
        <div className="hud">
          <div className="song-title">{g.chart.title}</div>
          <HealthBar health={g.board.health} />
          <div className="combo">{g.board.teamCombo > 4 ? `${g.board.teamCombo} COMBO` : ''}</div>
        </div>
        {t < 0 && <div className="countdown">{Math.ceil(-t)}</div>}
        <div className="channels">
          {CHANNELS.map((ch) => {
            const info = CHANNEL_INFO[ch]
            const p = g.roster.find((x) => x.channel === ch)
            const j = g.lastJudge[ch]
            const fresh = j && now - j.at < 450 ? j.r : null
            const card = g.cards[ch]
            const s = card.step(1 / 60, 16)
            const stats = p && g.board.stats.get(p.id)
            const judged = stats ? stats.perfect + stats.good + stats.miss : 0
            const weak = p && g.weakest === p.id
            return (
              <div
                key={ch}
                className={`channel-card ${fresh === 'miss' ? 'glitch' : ''} ${weak ? 'weakest' : ''}`}
                style={
                  {
                    '--c': info.color,
                    '--flash': card.flash.toFixed(2),
                    transform: s.x || s.y ? `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) rotate(${s.rot.toFixed(2)}deg)` : undefined,
                  } as React.CSSProperties
                }
              >
                {weak && <div className="weak-badge">☠ WEAKEST LINK</div>}
                <div className="channel-head">
                  <span>{info.name}</span>
                  <span className="dim">{info.wave}</span>
                </div>
                <Scope analyser={synth.channels[ch].analyser} color={info.color} />
                <div className="channel-stats">
                  <span>{judged ? `${Math.round(g.board.accuracy(p!.id) * 100)}%` : p ? '--%' : ''}</span>
                  {stats && stats.missStreak >= 2 && <span className="miss-streak">{'✕'.repeat(Math.min(6, stats.missStreak))}{stats.missStreak > 6 ? `${stats.missStreak}` : ''}</span>}
                </div>
                <div className="channel-foot">
                  <span>{p ? p.name : 'CPU'}</span>
                  {fresh && <span key={j!.at} className={`judge ${fresh}`}>{fresh === 'miss' ? 'MISS!' : fresh.toUpperCase()}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="cpu-strip" style={{ '--c': ARP_INFO.color } as React.CSSProperties}>
          <span>{ARP_INFO.wave}</span>
          <Scope analyser={synth.channels.arp.analyser} color={ARP_INFO.color} />
          <span className="dim">CPU</span>
        </div>
        {g.roast && (
          <div key={g.roast.at} className="roast-ticker">
            ☠ {g.roster.find((x) => x.id === g.roast!.playerId)?.name} {g.roast.text}
          </div>
        )}
        <div className="progress">
          <div style={{ width: `${Math.max(0, Math.min(1, t / g.chart.duration)) * 100}%` }} />
        </div>
      </div>
    )
  }

  const seated = players.filter((p) => p.channel)
  return wrap(
    <div className="screen host lobby" ref={screenRef}>
      <h1 className="logo">8-BIT<br />CHIP SQUAD</h1>
      <div className="lobby-grid">
        <div className="join-box">
          {qr ? <img src={qr} alt="Join QR code" className="qr" /> : <div className="qr placeholder" />}
          <div className="dim small">JOIN AT</div>
          <div className="join-url">{joinUrl.replace(/^https?:\/\//, '').replace(/\/play.*/, '/play')}</div>
          <div className="dim small">ROOM CODE</div>
          <div className="room-code">{code || '····'}</div>
        </div>
        <div className="slots">
          {CHANNELS.map((ch) => {
            const info = CHANNEL_INFO[ch]
            const p = players.find((x) => x.channel === ch)
            return (
              <div key={ch} className={`slot ${p ? 'filled' : ''}`} style={{ '--c': info.color } as React.CSSProperties}>
                <div className="slot-name">{info.name} <span className="dim">/ {info.game}</span></div>
                <div className="slot-player">{p ? p.name : 'CPU'}</div>
              </div>
            )
          })}
          <div className="songs">
            {SONGS.map((s) => (
              <button key={s.id} className={`song ${s.id === songId ? 'active' : ''}`} onClick={() => setSongId(s.id)}>
                {s.title}
                <span className="dim small">{s.difficulty} · {s.bpm} BPM</span>
              </button>
            ))}
          </div>
          <button className="btn big" disabled={!seated.length} onClick={toReady}>
            {seated.length ? 'START' : 'WAITING FOR PLAYERS'}
          </button>
        </div>
      </div>
      <p className="dim small footnote">
        {audioOn ? 'Empty channels are played by the CPU. Turn the volume up.' : 'Click anywhere to enable sound.'}
        <span className="nudge">
          SPEAKER DELAY
          <button className="btn tiny" onClick={() => setSpeakerDelay((d) => d - 10)}>-</button>
          {speakerDelay}MS
          <button className="btn tiny" onClick={() => setSpeakerDelay((d) => d + 10)}>+</button>
        </span>
      </p>
    </div>,
  )
}

function readStore(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}
