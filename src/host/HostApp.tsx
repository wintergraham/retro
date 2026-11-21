import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
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
import { CrtOverlay, type ScreenFx } from '../fx/CrtOverlay'
import { Juice, damageFromHealth } from '../fx/crt'

type Phase = 'lobby' | 'ready' | 'playing' | 'results'

interface Live {
  startAt: number
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
  // The room survives a reload or a dropped connection: the page reclaims it with the key the server gave it.
  const room = useRef<{ code: string; key: string } | null>(null)
  const net = useMemo(
    () =>
      new Net(() => {
        const resume = room.current ?? readJson<{ code: string; key: string }>(ROOM_KEY)
        net.send({ t: 'host:create', resume: resume ?? undefined, keep: !!room.current })
      }),
    [],
  )
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
    const wake = () => {
      const was = synth.ctx.state
      void synth.ctx.resume().then(() => {
        setAudioOn(true)
        // A song that started while the audio was locked was scheduled on a frozen clock: pick it up where it is now.
        const g = live.current
        if (was !== 'running' && g && !g.done) synth.play(g.chart, (g.startAt - net.serverNow()) / 1000)
      })
    }
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
      setQr(await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#26331c', light: '#a7b48a' } }))
    })()
  }, [code])

  // Song time as heard; if the audio is still locked (a reloaded page nobody has clicked yet) its clock is
  // frozen, so fall back to the shared clock or the song would never end.
  const songNow = (g: Live) => (synth.ctx.state === 'running' ? synth.songTime() : (net.serverNow() - g.startAt) / 1000)

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
            room.current = { code: msg.code, key: msg.key }
            try {
              sessionStorage.setItem(ROOM_KEY, JSON.stringify(room.current))
            } catch {}
            return setCode(msg.code)
          case 'players':
            return setPlayers(msg.players)
          case 'ready':
            setSongId(msg.songId)
            setReady(msg.ready)
            return setPhase('ready')
          case 'start': {
            if (live.current?.startAt === msg.startAt) return
            const chart = songById(msg.songId)
            const roster = playersRef.current.filter((p) => p.channel)
            live.current = { startAt: msg.startAt, chart, board: new Scoreboard(roster, chart), roster, lastJudge: {}, cards: newCards(), weakest: null, roast: null, done: false }
            synth.play(chart, (msg.startAt - net.serverNow()) / 1000)
            setResults(null)
            return setPhase('playing')
          }
          case 'judge': {
            const g = live.current
            const p = g?.roster.find((x) => x.id === msg.playerId)
            if (!g || !p?.channel || g.done) return
            const songTime = songNow(g)
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
              fx.juice.hitGlitch(0.08 + severity * 0.12)
              if (g.board.health < 40) fx.juice.shake(severity * 0.15)
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
      const songTime = songNow(g)
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
      // Phones judge until duration + 0.3 plus their own input offset, so leave room for late judgements.
      else if (songTime > g.chart.duration + 0.8) finish(true)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  // Leaving play: clean picture again.
  useEffect(() => {
    if (phase !== 'playing') fx.damage = 0
  }, [phase])

  // ▲▼ picks a song in the lobby, Enter starts.
  useEffect(() => {
    if (phase !== 'lobby') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      synth.ui('move')
      setSongId((id) => {
        const i = SONGS.findIndex((s) => s.id === id)
        return SONGS[(i + (e.key === 'ArrowUp' ? -1 : 1) + SONGS.length) % SONGS.length].id
      })
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [phase])

  // Buttons on the big screen click like a menu; the song list ticks like the arrow keys.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('button')
      if (!el || el.disabled) return
      synth.ui(el.matches('.song-row, .round-btn') ? 'move' : /BACK/.test(el.textContent ?? '') ? 'back' : 'select')
    }
    addEventListener('pointerdown', onDown)
    return () => removeEventListener('pointerdown', onDown)
  }, [synth])

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
  const top = (
    <div className="hx-top">
      <span className="brand">ChipSquad</span>
      <span className="print">3-CH SOUND</span>
      <div className="right">
        {phase === 'lobby' && (
          <span className="print" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            SPEAKER DELAY
            <button className="round-btn" onClick={() => setSpeakerDelay((d) => d - 10)} aria-label="Less speaker delay">−</button>
            {speakerDelay}MS
            <button className="round-btn" onClick={() => setSpeakerDelay((d) => d + 10)} aria-label="More speaker delay">+</button>
          </span>
        )}
        <span className="print">ROOM {code || '····'}</span>
        <span className="print">{audioOn ? '🔈 SOUND ON' : '🔇 CLICK FOR SOUND'}</span>
      </div>
    </div>
  )
  const wrap = (label: string, body: React.ReactNode, after?: React.ReactNode) => (
    <>
      <div className="hx" ref={screenRef}>
        {top}
        <div className="bezel">
          <div className="bezel-label"><i className="led" /> {label}</div>
          <div className="lcd">{body}</div>
        </div>
        {after}
      </div>
      <CrtOverlay fx={fx} onShake={shake} />
    </>
  )

  if (phase === 'results' && results) {
    const r = results
    return wrap(
      r.cleared ? 'STAGE CLEAR' : 'GAME OVER',
      <div className="hx-split">
        <div>
          <div className="t-px-s ink">{songById(r.songId).title}</div>
          <div className="rank-big">{r.rank}</div>
          <div className="hx-kicker" style={{ color: 'var(--ink)' }}>{r.cleared ? 'STAGE CLEAR!' : 'GAME OVER'}</div>
          <div className="t-vt">TEAM ACCURACY {Math.round(r.accuracy * 100)}%</div>
        </div>
        <div>
          <div className="awards-row">
            {r.awards.map((a) => (
              <div key={a.title} className="award-col">
                <span className="k"><b className="g">★</b>{a.title}</span>
                <span className="n">{a.name}</span>
                <span className="b">{a.blurb}</span>
              </div>
            ))}
          </div>
          <table className="res-table">
            <thead>
              <tr>
                <th>CH</th>
                <th>PLAYER</th>
                <th className="r">ACC</th>
                <th className="r">PERFECT / GOOD / MISS</th>
              </tr>
            </thead>
            <tbody>
              {r.players.map((p) => (
                <Fragment key={p.id}>
                  <tr>
                    <td><span className="sw" style={{ background: CHANNEL_INFO[p.channel].color }} />{CHANNEL_INFO[p.channel].name}</td>
                    <td>{p.name}</td>
                    <td className="r">{Math.round(p.accuracy * 100)}%</td>
                    <td className="r">{p.perfect} / {p.good} / {p.miss}</td>
                  </tr>
                  <tr className="q">
                    <td colSpan={4}>“{p.roast}”</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>,
      <div className="hx-actions">
        <span className="print-vt">EVERYONE'S PHONE GOES BACK TO THE LOBBY</span>
        <span className="spacer" />
        <button className="big-btn" onClick={backToLobby}><b className="g">↻</b> PLAY AGAIN</button>
      </div>,
    )
  }

  if (phase === 'ready') {
    const song = songById(songId)
    const seated = players.filter((p) => p.channel && p.connected)
    const waiting = seated.filter((p) => !ready.includes(p.id)).length
    return wrap(
      'READY UP',
      <>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 28, flexWrap: 'wrap' }}>
          <span className="t-px-s faint">NEXT UP</span>
          <h1 className="hx-title" style={{ fontSize: 'clamp(30px, 3.4vw, 48px)' }}>{song.title}</h1>
          <span className="t-vt faint">{song.difficulty} · {song.bpm} BPM · {Math.round(song.duration)} SECONDS</span>
        </div>
        <div className="ch-cards">
          {CHANNELS.map((ch) => {
            const info = CHANNEL_INFO[ch]
            const p = players.find((x) => x.channel === ch)
            const ok = p && ready.includes(p.id)
            return (
              <div key={ch} className={`ch-card ${ch} ${p ? '' : 'dashed'}`}>
                <div className="head">
                  <span className="px">{info.name}</span>
                  <span className="vt">{info.game.toUpperCase()}</span>
                </div>
                <div className="body">
                  <ol className="lcd-steps">
                    {CHANNEL_STEPS[ch].map((s) => <li key={s}>{s}</li>)}
                  </ol>
                </div>
                <div className="foot">
                  <span className="ch-name">{p ? p.name : 'CPU'}</span>
                  <span className={`tag ${ok ? '' : 'outline'}`}>{!p ? 'AUTO' : ok ? <>READY <b className="g">✓</b></> : 'WAITING…'}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="t-vt center">
          {waiting ? `WAITING FOR ${waiting} PLAYER${waiting > 1 ? 'S' : ''} TO HIT READY` : 'EVERYONE READY'} · ARP IS ON THE CPU
          {!audioOn && ' · CLICK ANYWHERE TO ENABLE SOUND'}
        </div>
      </>,
      <div className="hx-actions">
        <button className="big-btn ghost" onClick={backToLobby}><b className="g">←</b> BACK</button>
        <span className="spacer" />
        <span className="print-vt">STARTS BY ITSELF ONCE EVERYONE IS READY</span>
        <span className="spacer" />
        <button className="big-btn" onClick={startAnyway}>START ANYWAY <b className="g">▷</b></button>
      </div>,
    )
  }

  if (phase === 'playing' && live.current) {
    const g = live.current
    const t = songNow(g)
    const now = performance.now()
    const segs = 20
    const lit = Math.ceil((g.board.health / 100) * segs)
    const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    return wrap(
      `NOW PLAYING · ${g.chart.title} · ${g.chart.bpm} BPM`,
      <>
        <div className="hp-row">
          <span className="hp-song">{g.chart.title}</span>
          <span className="t-px-s ink">HP</span>
          <div className={`hp-bar ${g.board.health < 30 ? 'low' : ''}`}>
            {Array.from({ length: segs }, (_, i) => <i key={i} className={i < lit ? '' : 'off'} />)}
          </div>
          <span className="t-px-s ink" style={{ minWidth: 130, textAlign: 'right' }}>{g.board.teamCombo > 4 ? `${g.board.teamCombo} COMBO` : ''}</span>
        </div>
        {t < 0 && <div className="countdown hx-count">{Math.ceil(-t)}</div>}
        <div className="ch-cards">
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
                className={`ch-card ${ch} ${weak || !p ? 'dashed' : ''} ${fresh === 'miss' ? 'glitch' : ''}`}
                style={
                  {
                    '--flash': card.flash.toFixed(2),
                    transform: s.x || s.y ? `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) rotate(${s.rot.toFixed(2)}deg)` : undefined,
                  } as React.CSSProperties
                }
              >
                <div className="head">
                  <span className="px">{info.name}</span>
                  {weak ? <span className="badge"><b className="g">☠</b>WEAKEST LINK</span> : <span className="vt">{info.wave}</span>}
                </div>
                <div className="body">
                  <Scope analyser={synth.channels[ch].analyser} color="#26331c" />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span className="acc">{judged ? `${Math.round(g.board.accuracy(p!.id) * 100)}%` : p ? '--%' : 'CPU'}</span>
                    {stats && stats.missStreak >= 2 && (
                      <span className="misses">{'×'.repeat(Math.min(6, stats.missStreak))}{stats.missStreak > 6 ? stats.missStreak : ''}</span>
                    )}
                  </div>
                </div>
                <div className="foot">
                  <span className="ch-name">{p ? p.name : 'CPU'}</span>
                  {fresh && <span key={j!.at} className={`tag ${fresh === 'perfect' ? '' : 'outline'}`}>{fresh === 'miss' ? 'MISS!' : fresh.toUpperCase()}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="arp-strip">
          <span className="t-px-s ink">{ARP_INFO.wave}</span>
          <Scope analyser={synth.channels.arp.analyser} color="#5c6e45" />
          <span className="t-px-s faint">ARP · CPU</span>
        </div>
        {g.roast && (
          <div className="roast-bar">
            <span key={g.roast.at}><b className="g">☠</b>{g.roster.find((x) => x.id === g.roast!.playerId)?.name} {g.roast.text}</span>
          </div>
        )}
        <div className="prog">
          <span>{clock(Math.max(0, t))}</span>
          <div className="track">
            <div className="fill" style={{ width: `${Math.max(0, Math.min(1, t / g.chart.duration)) * 100}%` }} />
          </div>
          <span>{clock(g.chart.duration)}</span>
        </div>
      </>,
    )
  }

  const seated = players.filter((p) => p.channel)
  const host = joinUrl.replace(/^https?:\/\//, '').replace(/\/play.*/, '/play')
  return wrap(
    'CHIP SQUAD · BIG SCREEN',
    <div className="hx-split">
      <div>
        <div className="hx-qr">{qr && <img src={qr} alt="Join QR code" />}</div>
        <div className="t-px-s ink">SCAN TO JOIN · OR GO TO</div>
        <div className="hx-url">{host}</div>
        <div className="hx-code">
          {(code || '····').split('').map((c, i) => <span key={i} className="code-box">{c}</span>)}
        </div>
        <div className="t-px-s faint">ROOM CODE</div>
      </div>
      <div>
        <div className="hx-kicker">8-BIT</div>
        <h1 className="hx-title">CHIP SQUAD</h1>
        <div className="t-vt">3 PHONES · 1 BIG SCREEN · 60 SECONDS.<br />DON'T LET THE HP HIT ZERO.</div>
        <div className="lcd-row" style={{ marginTop: 10 }}>
          <span className="t-px-s ink">PICK A SONG</span>
          <span className="t-vt faint"><b className="g">▲▼</b> ON YOUR KEYBOARD</span>
        </div>
        <div className="song-list">
          {SONGS.map((s) => (
            <button key={s.id} className={`song-row ${s.id === songId ? 'active' : ''}`} onClick={() => setSongId(s.id)}>
              <b className="g">{s.id === songId ? '▶' : ''}</b>
              <span>{s.title}</span>
              <span className="meta">{s.difficulty} · {s.bpm} BPM</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    <div className="hx-actions">
      <div className="hx-carts">
        {CHANNELS.map((ch) => {
          const info = CHANNEL_INFO[ch]
          const p = players.find((x) => x.channel === ch)
          return (
            <div key={ch} className={`mini-cart ${ch} ${p ? '' : 'empty'}`}>
              <div className="mini-lcd">
                <div className="k">{info.name}</div>
                <div className="n">{p ? p.name : '—'}</div>
                <div className="g">{info.game.toUpperCase()}</div>
              </div>
              <div className="foot">
                <span>{info.wave}</span>
                <span>{p ? '● IN' : 'AUTO'}</span>
              </div>
            </div>
          )
        })}
        <div className="mini-cart arp">
          <div className="mini-lcd">
            <div className="k">ARP</div>
            <div className="n">CPU</div>
            <div className="g">ARPEGGIO</div>
          </div>
          <div className="foot">
            <span>{ARP_INFO.wave}</span>
            <span>AUTO</span>
          </div>
        </div>
      </div>
      <div className="note">
        <button className="big-btn" disabled={!seated.length} onClick={toReady}>
          {seated.length ? <>START <b className="g">▷</b></> : 'WAITING…'}
        </button>
        <span className="print-vt">
          {seated.length ? `${seated.length} PLAYER${seated.length > 1 ? 'S' : ''} IN` : 'NO PHONES YET'} · EMPTY CHANNELS ARE PLAYED BY THE CPU
        </span>
      </div>
    </div>,
  )
}

const ROOM_KEY = 'chip-squad:host-room'

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
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
