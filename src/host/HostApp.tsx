import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { CALIB, CHANNELS, CHANNEL_INFO, type ChannelId, type GameResults, type Judgement, type PlayerInfo } from '../../shared/protocol'
import { SONGS, songById, type Chart } from '../../shared/songs'
import { Net } from '../net'
import { ChipSynth } from './audio'
import { Scoreboard } from './scoring'
import { Scope } from './Scope'
import { HealthBar, Results } from '../ui'

type Phase = 'lobby' | 'playing' | 'results'

interface Live {
  chart: Chart
  board: Scoreboard
  roster: PlayerInfo[]
  lastJudge: Partial<Record<ChannelId, { r: Judgement; at: number }>>
  done: boolean
}

export function HostApp() {
  const [code, setCode] = useState('')
  const [players, setPlayers] = useState<PlayerInfo[]>([])
  const [phase, setPhase] = useState<Phase>('lobby')
  const [songId, setSongId] = useState(SONGS[0].id)
  const [results, setResults] = useState<GameResults | null>(null)
  const [joinUrl, setJoinUrl] = useState('')
  const [qr, setQr] = useState('')
  const [, setFrame] = useState(0)

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
          case 'start': {
            const chart = songById(msg.songId)
            const roster = playersRef.current.filter((p) => p.channel)
            live.current = { chart, board: new Scoreboard(roster), roster, lastJudge: {}, done: false }
            synth.play(chart, (msg.startAt - net.serverNow()) / 1000)
            setResults(null)
            return setPhase('playing')
          }
          case 'judge': {
            const g = live.current
            const p = g?.roster.find((x) => x.id === msg.playerId)
            if (!g || !p?.channel || g.done) return
            g.board.judge(p.id, msg.r, synth.songTime())
            g.lastJudge[p.channel] = { r: msg.r, at: performance.now() }
            if (msg.r === 'miss') synth.dropout(p.channel, g.chart.beat * (p.channel === 'arp' ? 2 : 0.6))
            return
          }
          case 'calib':
            if (live.current && !live.current.done) return
            return synth.clicks((msg.startAt - net.serverNow()) / 1000, CALIB.clicks, CALIB.interval)
          case 'bend': {
            const p = live.current?.roster.find((x) => x.id === msg.playerId)
            if (p?.channel !== 'bass') return
            // Small drift is forgiven; past that the triangle bends hard, up to ±7 semitones.
            const off = Math.max(0, Math.abs(msg.v) - 0.07)
            return synth.setBend(Math.sign(msg.v) * Math.min(700, off * 1800))
          }
        }
      }),
    [net, synth],
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
      if (now - lastHud > 200) {
        lastHud = now
        net.send({ t: 'host:hud', health: g.board.health, combo: g.board.teamCombo })
      }
      if (g.board.health <= 0) finish(false)
      else if (synth.songTime() > g.chart.duration + 0.3) finish(true)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  const start = async () => {
    await synth.ctx.resume()
    net.send({ t: 'host:start', songId })
  }

  const backToLobby = () => {
    live.current = null
    setPhase('lobby')
    net.send({ t: 'host:lobby' })
  }

  if (phase === 'results' && results) {
    return (
      <div className="screen host">
        <Results results={results} />
        <button className="btn big" onClick={backToLobby}>PLAY AGAIN</button>
      </div>
    )
  }

  if (phase === 'playing' && live.current) {
    const g = live.current
    const t = synth.songTime()
    const now = performance.now()
    return (
      <div className="screen host playing">
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
            const fresh = j && now - j.at < 400 ? j.r : null
            return (
              <div key={ch} className={`channel-card ${fresh === 'miss' ? 'glitch' : ''}`} style={{ '--c': info.color } as React.CSSProperties}>
                <div className="channel-head">
                  <span>{info.name}</span>
                  <span className="dim">{info.wave}</span>
                </div>
                <Scope analyser={synth.channels[ch].analyser} color={info.color} />
                <div className="channel-foot">
                  <span>{p ? p.name : 'CPU'}</span>
                  {fresh && <span className={`judge ${fresh}`}>{fresh.toUpperCase()}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="progress">
          <div style={{ width: `${Math.max(0, Math.min(1, t / g.chart.duration)) * 100}%` }} />
        </div>
      </div>
    )
  }

  const seated = players.filter((p) => p.channel)
  return (
    <div className="screen host lobby">
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
          <button className="btn big" disabled={!seated.length} onClick={start}>
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
    </div>
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
