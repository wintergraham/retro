import { useEffect, useMemo, useRef, useState } from 'react'
import { CALIB, CHANNELS, CHANNEL_INFO, type GameResults, type PlayerInfo } from '../../shared/protocol'
import { songById } from '../../shared/songs'
import { Net } from '../net'
import { HealthBar, Results } from '../ui'
import { GameCanvas } from './GameCanvas'
import { PhoneSfx } from './sfx'

type Phase = 'join' | 'lobby' | 'playing' | 'results'
type Tilt = 'off' | 'on' | 'denied'

const SESSION = 'chip-squad:session'
const OFFSET = 'inputOffset'

interface Session {
  code: string
  name: string
  playerId: string
}

const OrientationEvent = (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent as
  | { requestPermission?: () => Promise<'granted' | 'denied'> }
  | undefined

function load<T>(storage: () => Storage, key: string): T | null {
  try {
    const raw = storage().getItem(key)
    return raw == null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}

function save(storage: () => Storage, key: string, value: unknown) {
  try {
    if (value == null) storage().removeItem(key)
    else storage().setItem(key, JSON.stringify(value))
  } catch {}
}

const session = () => sessionStorage
const local = () => localStorage

export function PhoneApp() {
  const params = new URLSearchParams(location.search)
  const saved = load<Session>(session, SESSION)
  const roomParam = (params.get('room') ?? '').toUpperCase()
  const resume = saved && (!roomParam || saved.code === roomParam) ? saved : null

  const [phase, setPhase] = useState<Phase>('join')
  const [code, setCode] = useState(roomParam || resume?.code || '')
  const [name, setName] = useState(resume?.name ?? '')
  const [playerId, setPlayerId] = useState('')
  const [players, setPlayers] = useState<PlayerInfo[]>([])
  const [error, setError] = useState('')
  const [hud, setHud] = useState({ health: 100, combo: 0 })
  const [start, setStart] = useState<{ songId: string; startAt: number } | null>(null)
  const [results, setResults] = useState<GameResults | null>(null)
  const [tilt, setTilt] = useState<Tilt>(OrientationEvent?.requestPermission ? 'off' : 'on')
  const [inputOffset, setInputOffset] = useState(() => load<number>(local, OFFSET) ?? 0)
  const [calib, setCalib] = useState<{ startAt: number; taps: number } | null>(null)
  const [joining, setJoining] = useState(false)

  const sfx = useMemo(() => new PhoneSfx(), [])
  const [sfxOn, setSfxOn] = useState(sfx.enabled)
  const me = useRef<Session | null>(null)
  const pendingId = useRef(resume?.playerId)
  const pendingName = useRef('')
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null)
  const calibTaps = useRef<number[]>([])

  // Reconnects re-join with the same playerId so the server hands back our channel.
  const net = useMemo(
    () =>
      new Net(() => {
        const s = me.current
        if (s) net.send({ t: 'join', code: s.code, name: s.name, playerId: s.playerId })
      }),
    [],
  )
  useEffect(() => () => net.close(), [net])

  const leave = (msg: string) => {
    me.current = null
    pendingId.current = undefined
    save(session, SESSION, null)
    setPlayerId('')
    setJoining(false)
    setPhase('join')
    setError(msg)
  }

  useEffect(
    () =>
      net.on((msg) => {
        switch (msg.t) {
          case 'joined': {
            const s = { code: msg.code, name: me.current?.name ?? pendingName.current, playerId: msg.playerId }
            me.current = s
            save(session, SESSION, s)
            setPlayerId(msg.playerId)
            setJoining(false)
            setError('')
            return setPhase((p) => (p === 'join' ? 'lobby' : p))
          }
          case 'players':
            return setPlayers(msg.players)
          case 'start':
            setStart({ songId: msg.songId, startAt: msg.startAt })
            setHud({ health: 100, combo: 0 })
            setCalib(null)
            return setPhase('playing')
          case 'hud':
            return setHud({ health: msg.health, combo: msg.combo })
          case 'end':
            setResults(msg.results)
            return setPhase('results')
          case 'lobby':
            setStart(null)
            return setPhase('lobby')
          case 'host-left':
            return leave('HOST LEFT THE ROOM')
          case 'error':
            if (!me.current || msg.msg === 'Room not found') return leave(msg.msg.toUpperCase())
            return setError(msg.msg.toUpperCase())
          case 'calib':
            calibTaps.current = []
            return setCalib({ startAt: msg.startAt, taps: 0 })
        }
      }),
    [net],
  )

  // Finish calibration once the last click has had time to land.
  useEffect(() => {
    if (!calib) return
    const end = calib.startAt + CALIB.clicks * CALIB.interval * 1000 + 700
    const timer = setTimeout(() => {
      const step = CALIB.interval * 1000
      const deltas = calibTaps.current
        .map((tap) => {
          const i = Math.round((tap - calib.startAt) / step)
          return i >= 0 && i < CALIB.clicks ? tap - (calib.startAt + i * step) : NaN
        })
        .filter((d) => Math.abs(d) < step / 2)
        .sort((a, b) => a - b)
      setCalib(null)
      if (deltas.length < 4) return setError('CALIBRATION NEEDS MORE TAPS')
      const mid = deltas.length >> 1
      const median = deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2
      const ms = Math.round(median)
      setInputOffset(ms)
      save(local, OFFSET, ms)
      setError('')
    }, Math.max(0, end - net.serverNow()))
    return () => clearTimeout(timer)
  }, [calib?.startAt])

  // Keep the screen awake; the lock drops whenever the tab is hidden, so take it back on return.
  const lockScreen = async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }
      wakeLock.current = (await nav.wakeLock?.request('screen')) ?? null
    } catch {}
  }
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && me.current) void lockScreen()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const join = (e: React.FormEvent) => {
    e.preventDefault()
    const c = code.trim().toUpperCase()
    if (c.length !== 4) return setError('ENTER THE 4-LETTER ROOM CODE')
    sfx.unlock()
    void lockScreen()
    const n = name.trim().toUpperCase() || 'PLAYER'
    pendingName.current = n
    setJoining(true)
    setError('')
    net.send({ t: 'join', code: c, name: n, playerId: pendingId.current })
  }

  const enableTilt = async () => {
    try {
      setTilt((await OrientationEvent?.requestPermission?.()) === 'granted' ? 'on' : 'denied')
    } catch {
      setTilt('denied')
    }
  }

  const toggleSfx = () => {
    sfx.setEnabled(!sfxOn)
    setSfxOn(!sfxOn)
    sfx.unlock()
    if (!sfxOn) sfx.blip(true)
  }

  const mine = players.find((p) => p.id === playerId)
  const channel = mine?.channel ?? null

  if (phase === 'join') {
    return (
      <div className="screen phone join">
        <h1 className="logo small-logo">8-BIT<br />CHIP SQUAD</h1>
        <form className="join-form" onSubmit={join}>
          <label className="dim small" htmlFor="code">ROOM CODE</label>
          <input
            id="code"
            className="room-input"
            value={code}
            maxLength={4}
            autoCapitalize="characters"
            autoComplete="off"
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          />
          <label className="dim small" htmlFor="name">YOUR NAME</label>
          <input
            id="name"
            className="name-input"
            value={name}
            maxLength={12}
            autoComplete="nickname"
            placeholder="PLAYER"
            onChange={(e) => setName(e.target.value.toUpperCase())}
          />
          <button className="btn big" disabled={joining}>{joining ? 'JOINING…' : 'JOIN'}</button>
          {error && <div className="error">{error}</div>}
        </form>
      </div>
    )
  }

  if (phase === 'results' && results) {
    return (
      <div className="screen phone">
        <Results results={results} me={playerId} />
        <p className="dim small">WAITING FOR THE HOST…</p>
      </div>
    )
  }

  if (phase === 'playing' && start) {
    const chart = songById(start.songId)
    const info = channel ? CHANNEL_INFO[channel] : null
    return (
      <div className="screen phone playing" style={{ '--c': info?.color ?? '#fff' } as React.CSSProperties}>
        <div className="hud">
          <HealthBar health={hud.health} />
          <div className="phone-hud-row">
            <span className="channel-tag">{info ? info.name : 'SPECTATING'}</span>
            <span className="combo">{hud.combo > 4 ? `${hud.combo} COMBO` : ''}</span>
          </div>
        </div>
        {channel ? (
          <GameCanvas net={net} chart={chart} startAt={start.startAt} channel={channel} sfx={sfx} inputOffset={inputOffset / 1000} />
        ) : (
          <div className="spectate dim">ENJOY THE SHOW</div>
        )}
        <Countdown net={net} startAt={start.startAt} beat={chart.beat} sfx={sfx} />
      </div>
    )
  }

  // Lobby
  const info = channel ? CHANNEL_INFO[channel] : null
  return (
    <div className="screen phone lobby" style={{ '--c': info?.color ?? '#fff' } as React.CSSProperties}>
      <div className="phone-top">
        <span className="dim small">ROOM {me.current?.code}</span>
        <span className="small">{mine?.name}</span>
      </div>
      {info && (
        <div className="my-channel">
          <div className="dim small">YOU ARE</div>
          <div className="my-channel-name">{info.name}</div>
          <div className="dim small">{info.wave} · {info.game}</div>
          <p className="how-to">{info.howTo}</p>
        </div>
      )}
      {channel === 'bass' && tilt !== 'on' && (
        <button className="btn" onClick={enableTilt}>{tilt === 'denied' ? 'TILT DENIED · DRAG INSTEAD' : 'ENABLE TILT'}</button>
      )}
      <div className="pick-grid">
        {CHANNELS.map((ch) => {
          const owner = players.find((p) => p.channel === ch)
          return (
            <button
              key={ch}
              className={`pick ${ch === channel ? 'active' : ''}`}
              style={{ '--c': CHANNEL_INFO[ch].color } as React.CSSProperties}
              disabled={ch === channel}
              onClick={() => net.send({ t: 'pick', channel: ch })}
            >
              {CHANNEL_INFO[ch].name}
              <span className="dim small">{owner ? (owner.id === playerId ? 'YOU' : owner.name) : 'CPU'}</span>
            </button>
          )
        })}
      </div>
      <div className="phone-tools">
        <button className="btn small" onClick={() => (sfx.unlock(), net.send({ t: 'calib' }))}>CALIBRATE</button>
        <span className="small dim">{inputOffset >= 0 ? '+' : ''}{inputOffset}MS</span>
        <button className="btn small" onClick={toggleSfx}>SFX {sfxOn ? 'ON' : 'OFF'}</button>
      </div>
      {error && <div className="error">{error}</div>}
      <p className="dim small">WAITING FOR THE HOST TO START…</p>
      {calib && (
        <div
          className="calib"
          onPointerDown={(e) => {
            calibTaps.current.push(e.timeStamp + net.offset)
            navigator.vibrate?.(8)
            setCalib((c) => c && { ...c, taps: c.taps + 1 })
          }}
        >
          <div>LISTEN TO THE HOST SPEAKER</div>
          <div className="dim small">TAP ANYWHERE ON EACH OF THE {CALIB.clicks} CLICKS</div>
          <div className="calib-count">{calib.taps}</div>
        </div>
      )}
    </div>
  )
}

/** 3-2-1 overlay over the game during the lead-in, with quiet blips on the host's count-in beats. */
function Countdown({ net, startAt, beat, sfx }: { net: Net; startAt: number; beat: number; sfx: PhoneSfx }) {
  const [label, setLabel] = useState('')
  useEffect(() => {
    let raf = 0
    let lastBeat = Infinity
    const loop = () => {
      const t = (net.serverNow() - startAt) / 1000
      if (t > 0.6) return setLabel('')
      raf = requestAnimationFrame(loop)
      setLabel(t < 0 ? String(Math.ceil(-t)) : 'GO!')
      const b = Math.ceil(-t / beat)
      if (b < lastBeat && b >= 1 && b <= 3) sfx.blip(b === 1)
      lastBeat = Math.min(lastBeat, b)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [net, startAt, beat, sfx])
  return label ? <div className="countdown">{label}</div> : null
}
