import { useEffect, useMemo, useRef, useState } from 'react'
import { CALIB, CHANNELS, CHANNEL_INFO, CHANNEL_STEPS, type ChannelId, type GameResults, type PlayerInfo } from '../../shared/protocol'
import { songById } from '../../shared/songs'
import { Net } from '../net'
import { GameCanvas, type Readout } from './GameCanvas'
import { PhoneSfx } from './sfx'

type Phase = 'join' | 'lobby' | 'ready' | 'playing' | 'results'
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
  const [hud, setHud] = useState<{ health: number; combo: number; weakest: string | null; roast: string | null }>({ health: 100, combo: 0, weakest: null, roast: null })
  const healthRef = useRef(100)
  healthRef.current = hud.health
  const [readyUp, setReadyUp] = useState<{ songId: string; ready: string[] } | null>(null)
  const [start, setStart] = useState<{ songId: string; startAt: number } | null>(null)
  const [results, setResults] = useState<GameResults | null>(null)
  const [tilt, setTilt] = useState<Tilt>(OrientationEvent?.requestPermission ? 'off' : 'on')
  const [inputOffset, setInputOffset] = useState(() => load<number>(local, OFFSET) ?? 0)
  const [calib, setCalib] = useState<{ startAt: number; taps: number } | null>(null)
  // A reload with a saved session rejoins by itself, straight back into the running song.
  const [joining, setJoining] = useState(!!resume)

  const sfx = useMemo(() => new PhoneSfx(), [])
  const [sfxOn, setSfxOn] = useState(sfx.enabled)
  const me = useRef<Session | null>(resume)
  const joined = useRef(false)
  const pendingId = useRef(resume?.playerId)
  const pendingName = useRef('')
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null)
  const calibTaps = useRef<number[]>([])
  // Title screen (slide to insert) only when nobody handed us a room yet.
  const [title, setTitle] = useState(!roomParam && !resume)
  const keys = useRef<((i: number, down: boolean, timeStamp: number) => void) | null>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const gaugeRef = useRef<HTMLDivElement>(null)
  // Written straight to the DOM every frame so the LCD footer doesn't re-render the game.
  const readout = useMemo(() => {
    let shown = ''
    return (r: Readout) => {
      const el = footRef.current
      const mm = Math.max(0, Math.floor(r.t))
      const clock = `♪ ${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
      const fresh = r.last && performance.now() - r.lastAt < 900 ? (r.last === 'miss' ? 'MISS!' : r.last.toUpperCase() + '!') : ''
      const st = (Math.sign(r.drift) * Math.max(0, Math.abs(r.drift) - 0.07) * 4000) / 100
      const bass = Math.abs(st) < 0.5 ? 'IN TUNE' : 'OUT OF TUNE'
      const text = gaugeRef.current
        ? `${bass}<span>${st >= 0 ? '+' : '−'}${Math.abs(st).toFixed(1)} ST</span><span>${clock}</span>`
        : `${fresh ? `<span>${fresh}</span>` : ''}<span>${clock}</span>`
      if (el && text !== shown) {
        el.innerHTML = text
        shown = text
      }
      if (gaugeRef.current) gaugeRef.current.style.setProperty('--x', (Math.max(-1, Math.min(1, r.drift / 0.3))).toFixed(3))
    }
  }, [])

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

  // Every button on the shell answers with a menu sound. Game keys play the instrument instead.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('button, .slider, .code-boxes, .name-field')
      if (!el || (el as HTMLButtonElement).disabled || el.closest('.note-keys, .drum-keys')) return
      sfx.unlock()
      const label = el.getAttribute('aria-label') ?? el.textContent ?? ''
      sfx.ui(
        /leave/i.test(label) ? 'back'
        : el.matches('.knob, .slab') ? 'press'
        : el.matches('.pill, .lcd-arrow') ? 'pick'
        : el.matches('.slot-btn') ? 'toggle'
        : 'tap',
      )
    }
    addEventListener('pointerdown', onDown)
    return () => removeEventListener('pointerdown', onDown)
  }, [sfx])

  const leave = (msg: string) => {
    me.current = null
    joined.current = false
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
            joined.current = true
            save(session, SESSION, s)
            void lockScreen()
            setPlayerId(msg.playerId)
            setJoining(false)
            setError('')
            return setPhase((p) => (p === 'join' ? 'lobby' : p))
          }
          case 'players':
            return setPlayers(msg.players)
          case 'ready':
            setReadyUp({ songId: msg.songId, ready: msg.ready })
            return setPhase((p) => (p === 'join' ? p : 'ready'))
          case 'start':
            setStart({ songId: msg.songId, startAt: msg.startAt })
            setHud({ health: 100, combo: 0, weakest: null, roast: null })
            setCalib(null)
            setReadyUp(null)
            return setPhase('playing')
          case 'hud':
            return setHud({ health: msg.health, combo: msg.combo, weakest: msg.weakest, roast: msg.roast })
          case 'end':
            setResults(msg.results)
            return setPhase('results')
          case 'lobby':
            setStart(null)
            setReadyUp(null)
            return setPhase('lobby')
          case 'host-left':
            return leave('HOST LEFT THE ROOM')
          case 'error':
            if (!joined.current || msg.msg === 'Room not found') return leave(msg.msg.toUpperCase())
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

  const startCalib = () => {
    sfx.unlock()
    setError('')
    net.send({ t: 'calib' })
  }

  const leaveRoom = () => {
    net.send({ t: 'leave' })
    leave('')
    setCode('')
    setTitle(true)
  }

  const calibTap = (e: React.PointerEvent) => {
    if (!calib) return
    const at = e.timeStamp + net.offset
    calibTaps.current.push(at)
    navigator.vibrate?.(8)
    setCalib((c) => c && { ...c, taps: c.taps + 1 })
  }

  const foot = (
    <div className="gb-foot">
      <div className="slot-row">
        <button className="slot-btn" onClick={startCalib}>CALIB</button>
        <button className="slot-btn" onClick={toggleSfx}>SFX {sfxOn ? 'ON' : 'OFF'}</button>
      </div>
      <Grille />
    </div>
  )

  // Title: the cartridge waits above the console until you slide it in.
  if (phase === 'join' && title && !joining) {
    return (
      <div className="gb title">
        <Chevrons />
        <div className="cart">
          <div className="cart-ridges">{Array.from({ length: 10 }, (_, i) => <i key={i} />)}</div>
          <div className="cart-label">
            <div className="cart-stripe"><i /><i /><i /><i /></div>
            <div className="cart-kicker">8-BIT</div>
            <div className="cart-title">CHIP<br />SQUAD</div>
            <div className="cart-sub">3-CHANNEL PARTY CART</div>
          </div>
        </div>
        <div className="console">
          <div className="console-slot" />
          <div className="bezel">
            <div className="bezel-label"><i className="led off" /> CHIP SQUAD · COLOR</div>
            <div className="lcd" style={{ minHeight: 150, justifyContent: 'center', alignItems: 'center', gap: 14 }}>
              <div className="t-px-m faint">NO CARTRIDGE</div>
              <div className="t-vt faint"><b className="g">▼</b>INSERT TO PLAY</div>
            </div>
          </div>
          <div className="lcd-row">
            <span className="brand">ChipSquad</span>
            <span className="print">3-CH SOUND</span>
          </div>
          <SlideToInsert
            onDone={() => {
              sfx.unlock()
              sfx.blip(true)
              setTitle(false)
            }}
          />
          <div className="print">3 PHONES · 1 BIG SCREEN · 60 SECONDS</div>
        </div>
      </div>
    )
  }

  if (phase === 'join') {
    const letters = code.padEnd(4).slice(0, 4).split('')
    return (
      <form className="gb join-skin" onSubmit={join}>
        <div className="cart">
          <div className="cart-ridges">{Array.from({ length: 10 }, (_, i) => <i key={i} />)}</div>
        </div>
        <div className="console">
          <div className="console-slot" />
          <div className="bezel">
            <div className="bezel-label"><i className="led" /> {joining ? 'LOADING…' : 'CART LOADED'}</div>
            <div className="lcd">
              <div className="lcd-row">
                <span className="t-px-s ink">ROOM CODE</span>
                <span className="t-vt-s faint">ON THE BIG SCREEN</span>
              </div>
              <label className="code-boxes" htmlFor="code">
                {letters.map((ch, i) => (
                  <span key={i} className={`code-box ${i === Math.min(code.length, 3) && code.length < 4 ? 'cursor' : ''}`}>
                    {ch.trim() && !(i === code.length && code.length < 4) ? ch : ''}
                  </span>
                ))}
                <input
                  id="code"
                  value={code}
                  maxLength={4}
                  autoCapitalize="characters"
                  autoComplete="off"
                  aria-label="Room code"
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
                />
              </label>
              <div className="name-field">
                <label htmlFor="name">NAME</label>
                <input
                  id="name"
                  value={name}
                  maxLength={12}
                  autoComplete="nickname"
                  placeholder="PLAYER"
                  onChange={(e) => setName(e.target.value.toUpperCase())}
                />
              </div>
            </div>
          </div>
          <div className="join-row">
            <span className="print">SCANNED THE QR?<br />CODE FILLS IN.</span>
            <span className="print">{joining ? 'JOINING…' : 'JOIN'}</span>
            <button className={`knob ${code.length === 4 && !joining ? '' : 'idle'}`} disabled={joining} aria-label="Join" />
          </div>
          {error && <div className="error">{error}</div>}
          <div className="gb-foot">
            <span className="brand">ChipSquad</span>
            <Grille />
          </div>
        </div>
      </form>
    )
  }

  const info = channel ? CHANNEL_INFO[channel] : null

  // Calibration: tap along with the host's clicks; ticks show how early or late each tap was.
  if (calib) {
    const step = CALIB.interval * 1000
    const now = net.serverNow()
    const click = Math.floor((now - calib.startAt) / step) + 1
    const deltas = calibTaps.current
      .map((tap) => tap - (calib.startAt + Math.round((tap - calib.startAt) / step) * step))
      .filter((d) => Math.abs(d) < step / 2)
    const avg = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0
    return (
      <div className="gb calibrating spread" data-ch={channel ?? undefined}>
        <div className="tap-zone" onPointerDown={calibTap} />
        <Bezel label="CHIP SQUAD · COLOR">
          <div className="lcd-row">
            <span className="t-px-s ink">CALIBRATE</span>
            <span className="t-px-s ink">{Math.min(calib.taps, CALIB.clicks)}/{CALIB.clicks}</span>
          </div>
          <div className="t-px-xl ink center" style={{ margin: '4px 0 2px' }}>{Math.min(calib.taps, CALIB.clicks)}</div>
          <div className="calib-boxes">
            {Array.from({ length: CALIB.clicks }, (_, i) => (
              <i key={i} className={i < calib.taps ? 'on' : i === calib.taps ? 'now' : ''} />
            ))}
          </div>
          <div className="t-vt center">TAP ON EACH CLICK FROM THE BIG SCREEN</div>
          <div className="t-vt faint">
            ♪ {click < 1 ? 'LISTEN…' : click > CALIB.clicks ? 'DONE' : `LISTEN…  CLICK ${click} OF ${CALIB.clicks}`}
          </div>
        </Bezel>
        <div className="gb-section">
          <div className="lcd-row">
            <span className="print">YOUR TIMING</span>
            <span className="print">{deltas.length ? `${avg >= 0 ? '+' : ''}${avg}MS ${avg > 15 ? 'LATE' : avg < -15 ? 'EARLY' : 'ON TIME'}` : '--'}</span>
          </div>
          <div className="timing-bar">
            <div className="zone" />
            <div className="mid" />
            {deltas.map((d, i) => (
              <div key={i} className="tick" style={{ left: `${50 + Math.max(-46, Math.min(46, (d / 200) * 50))}%` }} />
            ))}
          </div>
          <div className="lcd-row" style={{ padding: '0 14px' }}>
            <span className="print" style={{ fontSize: 8 }}>EARLY</span>
            <span className="print" style={{ fontSize: 8 }}>ON TIME</span>
            <span className="print" style={{ fontSize: 8 }}>LATE</span>
          </div>
        </div>
        <div className="knob-col tap-col">
          <div className="knob" style={{ '--s': '132px', fontSize: 18, color: '#fff' } as React.CSSProperties}>TAP</div>
          <div className="print-vt">OR TAP ANYWHERE ON THE SCREEN</div>
        </div>
        {foot}
        <CalibTicker />
      </div>
    )
  }

  if (phase === 'results' && results) {
    const r = results
    const meRes = r.players.find((p) => p.id === playerId)
    const awardFor = (id: string) => r.awards.find((a) => a.playerId === id)?.title
    return (
      <div className="gb gb-results spread" data-ch={meRes?.channel}>
        <Bezel label={r.cleared ? 'STAGE CLEAR' : 'GAME OVER'}>
          <div className="rank-lcd">
            <span className="rank-letter ink">{r.rank}</span>
            <span className="t-px-m ink">TEAM RANK</span>
            <span className="t-vt">{songById(r.songId).title} · {Math.round(r.accuracy * 100)}%</span>
            <span className="t-vt faint">{r.cleared ? 'STAGE CLEAR!' : 'THE BAND BROKE UP'}</span>
          </div>
          <div className="t-vt faint">WAITING FOR HOST…</div>
        </Bezel>
        <div className="gb-section">
          <div className="lcd-row"><span className="print">THE BAND · ARP: CPU</span></div>
          <div className="band-cards">
            {r.players.map((p) => (
              <div key={p.id} className={`band-card ${p.channel}`}>
                <div className="mini-lcd"><AwardIcon award={awardFor(p.id)} /></div>
                <div className="n">{p.id === playerId ? 'You' : cap(p.name)}</div>
                <div className="a">{awardFor(p.id) ? cap(awardFor(p.id)!) : `${Math.round(p.accuracy * 100)}%`}</div>
                <div className="roast">“{p.roast}”</div>
              </div>
            ))}
          </div>
        </div>
        {meRes && (
          <div className="gb-section">
            <div className="lcd-row"><span className="print">YOUR RUN · {CHANNEL_INFO[meRes.channel].name}</span></div>
            <div className="run-stats">
              <div><span className="v">{Math.round(meRes.accuracy * 100)}%</span><span className="print" style={{ fontSize: 8 }}>ACCURACY</span></div>
              <div><span className="v">×{meRes.maxCombo}</span><span className="print" style={{ fontSize: 8 }}>BEST COMBO</span></div>
              <div><span className="v">{meRes.miss}</span><span className="print" style={{ fontSize: 8 }}>MISSES</span></div>
            </div>
          </div>
        )}
        <div className="gb-foot">
          <Grille />
          <div className="ab">
            <Knob label="LEAVE" onClick={leaveRoom} />
            <Knob label="SHARE" onClick={() => shareResult(r, meRes)} />
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'playing' && start) {
    const chart = songById(start.songId)
    if (!info) {
      return (
        <div className="gb play">
          <Bezel label="SPECTATING" grow>
            <div className="t-px-m ink center" style={{ margin: 'auto' }}>ENJOY THE SHOW</div>
          </Bezel>
          {foot}
        </div>
      )
    }
    const ch = channel!
    const weak = hud.weakest && hud.weakest === playerId
    return (
      <div className="gb play" data-ch={ch}>
        <Bezel label={`CH${CHANNELS.indexOf(ch) + 1} · ${info.wave} · ${info.game}`} grow>
          <div className="play-head">
            <Hearts health={hud.health} />
            <span className="combo-x">×{hud.combo}</span>
          </div>
          {weak && (
            <div className="weak-lcd">
              <b><span className="g">☠</span>WEAKEST LINK</b>
              {hud.roast ? `${me.current?.name ?? 'YOU'} ${hud.roast}` : 'PICK IT UP!'}
            </div>
          )}
          <GameCanvas
            net={net}
            chart={chart}
            startAt={start.startAt}
            channel={ch}
            sfx={sfx}
            inputOffset={inputOffset / 1000}
            health={healthRef}
            keys={keys}
            readout={readout}
          />
          <div className="play-foot" ref={footRef} />
          <Countdown net={net} startAt={start.startAt} beat={chart.beat} sfx={sfx} title={`${chart.title} · ${chart.bpm} BPM`} channel={info.name} />
        </Bezel>
        {ch === 'lead' && (
          <div className="note-keys">
            {['C', 'E', 'G', 'B'].map((k, i) => <HwKey key={k} i={i} keys={keys}>{k}</HwKey>)}
          </div>
        )}
        {ch === 'drums' && (
          <div className="drum-keys">
            {['KICK', 'TOM', 'SNARE'].map((k, i) => (
              <div key={k} className="knob-col">
                <HwKey i={i} keys={keys} ring />
                <span className="print">{k}</span>
              </div>
            ))}
          </div>
        )}
        {ch === 'bass' && (
          <div className="gb-section">
            <div className="tilt-gauge">
              <div className="knob" ref={gaugeRef} />
            </div>
            <div className="tilt-labels">
              <span className="print"><PxArrow dir={-1} /> TILT</span>
              <span className="print-vt">{tilt === 'on' ? 'OR DRAG THE SCREEN' : 'DRAG THE SCREEN'}</span>
              <span className="print">TILT <PxArrow dir={1} /></span>
            </div>
          </div>
        )}
        <div className="gb-foot" style={{ minHeight: 0 }}>
          <span />
          <Grille />
        </div>
      </div>
    )
  }

  if (phase === 'ready' && readyUp) {
    const song = songById(readyUp.songId)
    const amReady = readyUp.ready.includes(playerId)
    const seated = players.filter((p) => p.channel && p.connected)
    const count = seated.filter((p) => readyUp.ready.includes(p.id)).length
    return (
      <div className="gb spread" data-ch={channel ?? undefined}>
        <Bezel label="CHIP SQUAD · COLOR">
          <div className="lcd-row">
            <span className="t-px-s ink">{song.title}</span>
            <span className="t-px-s ink">{song.bpm} BPM</span>
          </div>
          {info ? (
            <>
              <ChannelHero ch={channel!} />
              <hr className="lcd-rule" />
              <ol className="lcd-steps">
                {CHANNEL_STEPS[channel!].map((s) => <li key={s}>{s}</li>)}
              </ol>
              <div className="t-vt faint">
                {channel === 'bass' ? (tilt === 'on' ? '✓ TILT ON' : tilt === 'denied' ? '✕ TILT OFF · DRAG' : 'Ⓑ ENABLE TILT') + ' · ' : ''}
                CALIB {inputOffset >= 0 ? '+' : ''}{inputOffset}MS
              </div>
            </>
          ) : (
            <div className="t-px-m ink center" style={{ padding: '30px 0' }}>YOU'RE SPECTATING<br />THIS ONE</div>
          )}
        </Bezel>
        {info && (
          <>
            <div className="gb-section">
              <div className="lcd-row">
                <span className="print">READY CHECK</span>
                <span className="print">{count}/{seated.length}</span>
              </div>
              <div className="pills">
                {seated.map((p) => {
                  const ok = readyUp.ready.includes(p.id)
                  return (
                    <div key={p.id} className={`pill ${p.channel} ${ok ? '' : 'waiting'}`}>
                      {ok && <b className="g">✓</b>}{p.id === playerId ? 'YOU' : p.name}{ok ? '' : '…'}
                    </div>
                  )
                })}
              </div>
            </div>
            <button
              className={`slab ${amReady ? 'on' : ''}`}
              onClick={() => {
                sfx.unlock()
                if (!amReady) sfx.blip(true)
                navigator.vibrate?.(15)
                net.send({ t: 'ready', on: !amReady })
              }}
            >
              <span className="dot" />
              READY!
            </button>
            <div className="print-vt" style={{ textAlign: 'center' }}>
              {amReady ? 'TAP AGAIN TO UNDO' : channel === 'bass' && tilt === 'off' ? 'HIT TILT BELOW FIRST' : 'TAP WHEN YOU’VE GOT IT'}
            </div>
            {channel === 'bass' && tilt === 'off' && (
              <button className="pill bass" style={{ alignSelf: 'center', padding: '0 24px' }} onClick={enableTilt}>ENABLE TILT</button>
            )}
          </>
        )}
        {error && <div className="error">{error}</div>}
        {foot}
      </div>
    )
  }

  // Lobby
  const owner = (ch: ChannelId) => players.find((p) => p.channel === ch)
  const seatedCount = players.filter((p) => p.channel).length
  const cycle = (dir: number) => {
    if (!channel) return
    const next = CHANNELS[(CHANNELS.indexOf(channel) + dir + CHANNELS.length) % CHANNELS.length]
    navigator.vibrate?.(8)
    net.send({ t: 'pick', channel: next })
  }
  return (
    <div className="gb spread" data-ch={channel ?? undefined}>
      <Bezel label="CHIP SQUAD · COLOR">
        <div className="lcd-row">
          <span className="t-px-s ink">ROOM {me.current?.code}</span>
          <span className="t-px-s ink">{seatedCount}/3</span>
        </div>
        {channel ? (
          <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 28px', alignItems: 'center' }}>
            <button className="lcd-arrow" onClick={() => cycle(-1)} aria-label="Previous channel"><PxArrow dir={-1} /></button>
            <ChannelHero ch={channel} hideKicker />
            <button className="lcd-arrow" onClick={() => cycle(1)} aria-label="Next channel"><PxArrow dir={1} /></button>
          </div>
        ) : (
          <div className="t-px-m ink center" style={{ padding: '24px 0' }}>SPECTATING</div>
        )}
        <div className="lcd-slots">
          {CHANNELS.map((ch) => {
            const o = owner(ch)
            return (
              <div key={ch} className={`lcd-slot ${o?.id === playerId ? 'me' : ''} ${o ? '' : 'cpu'}`}>
                <span className="px">{ch === 'drums' ? 'DRUM' : CHANNEL_INFO[ch].name}</span>
                <span className="vt">{o ? (o.id === playerId ? 'YOU' : o.name) : 'CPU'}</span>
              </div>
            )
          })}
          <div className="lcd-slot cpu">
            <span className="px">ARP</span>
            <span className="vt">CPU</span>
          </div>
        </div>
        <div className="t-vt faint" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {channel === 'bass' && tilt !== 'on' ? (tilt === 'denied' ? 'TILT DENIED · DRAG' : 'Ⓑ ENABLE TILT') + ' · ' : ''}WAITING FOR HOST…
        </div>
      </Bezel>
      <div className="gb-section">
        <div className="lcd-row">
          <span className="print">YOUR PHONE BECOMES</span>
          <span className="print">{info ? `${info.name} ${SHELL_NAME[channel!]}` : ''}</span>
        </div>
        <div className="pills">
          {CHANNELS.map((ch) => (
            <button
              key={ch}
              className={`pill ${ch} ${ch === channel ? 'selected' : ''}`}
              disabled={ch === channel}
              onClick={() => {
                navigator.vibrate?.(8)
                net.send({ t: 'pick', channel: ch })
              }}
            >
              {ch === channel && <b className="g">✓</b>}{ch === 'drums' ? 'DRUM' : CHANNEL_INFO[ch].name}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="gb-pad-row">
        <div className="dpad" />
        <div className="ab">
          <Knob label="LEAVE" onClick={leaveRoom} />
          {channel === 'bass' ? <Knob label="TILT" onClick={enableTilt} /> : <Knob label="CALIB" onClick={startCalib} />}
        </div>
      </div>
      {foot}
    </div>
  )
}

const SHELL_NAME: Record<ChannelId, string> = { lead: 'ORANGE', bass: 'GREEN', drums: 'BLUE' }

// Title case, keeping the little words small ("Carried the Band", "Most Out of Tune").
const cap = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase())
    .replace(/(?<=\s)(Of|The|A|An|And|In|On|To)(?=\s)/g, (w) => w.toLowerCase())

function shareResult(r: GameResults, me?: GameResults['players'][number]) {
  const text = `Chip Squad: ${songById(r.songId).title} · rank ${r.rank}${me ? ` · I hit ${Math.round(me.accuracy * 100)}% on ${CHANNEL_INFO[me.channel].name}` : ''}`
  if (navigator.share) void navigator.share({ text }).catch(() => {})
  else void navigator.clipboard?.writeText(text).catch(() => {})
}

function Bezel({ label, grow, children }: { label: string; grow?: boolean; children: React.ReactNode }) {
  return (
    <div className={`bezel ${grow ? 'grow' : ''}`}>
      <div className="bezel-label"><i className="led" /> {label}</div>
      <div className="lcd">{children}</div>
    </div>
  )
}

/** Chunky pixel arrow for the LCD and shell print (the pixel font has no ◀ ▶). */
function PxArrow({ dir }: { dir: 1 | -1 }) {
  return (
    <svg className="px-arrow" viewBox="0 0 6 10" style={dir < 0 ? { transform: 'scaleX(-1)' } : undefined} aria-hidden>
      <path d="M0 0H2V1H3V2H4V3H5V4H6V6H5V7H4V8H3V9H2V10H0Z" fill="currentColor" />
    </svg>
  )
}

/** Double chevron: the "insert here" hint over the cart and the slider thumb. */
function Chevrons({ right }: { right?: boolean }) {
  return (
    <svg className={right ? 'chev right' : 'chev'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 5l6 6 6-6M6 13l6 6 6-6" />
    </svg>
  )
}

/** Line icon for a results award, drawn on the band card's mini LCD. */
function AwardIcon({ award }: { award?: string }) {
  const d =
    award === 'CARRIED THE BAND'
      ? 'M4 18h16M5 15 3.5 7l5 4L12 5l3.5 6 5-4L19 15Z'
      : award === 'MOST OUT OF TUNE'
        ? 'M3 12c2 0 2-5 4-5s2 10 4 10 2-12 4-12 2 9 4 9 2-2 2-2'
        : award === 'COMBO GOBLIN'
          ? 'M12 21c-4 0-6.5-2.6-6.5-6 0-4 4-6 4.5-11 3 2 4 4.5 4 7 1-.8 1.6-2 1.8-3 1.5 1.6 2.7 4 2.7 7 0 3.4-2.5 6-6.5 6Z'
          : award === 'HUMAN METRONOME'
            ? 'M9 3h6l4 18H5Zm3 15 4-11M7.5 15h9'
            : 'M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z'
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

function Grille() {
  return <div className="grille" aria-hidden>{Array.from({ length: 6 }, (_, i) => <i key={i} />)}</div>
}

function Knob({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="knob-col">
      <button className="knob" onClick={onClick} aria-label={label} />
      <span className="print">{label}</span>
    </div>
  )
}

/** A hardware key under the screen that presses the matching lane or pad. */
function HwKey({ i, keys, ring, children }: { i: number; keys: KeysRef; ring?: boolean; children?: React.ReactNode }) {
  const [down, setDown] = useState(false)
  return (
    <button
      className={`knob ${ring ? 'ring' : ''} ${down ? 'down' : ''}`}
      onPointerDown={(e) => {
        e.preventDefault()
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        setDown(true)
        keys.current?.(i, true, e.timeStamp)
      }}
      onPointerUp={(e) => {
        setDown(false)
        keys.current?.(i, false, e.timeStamp)
      }}
      onPointerCancel={(e) => {
        setDown(false)
        keys.current?.(i, false, e.timeStamp)
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  )
}

type KeysRef = { current: ((i: number, down: boolean, timeStamp: number) => void) | null }

/** Big channel name with its waveform, as on the lobby and ready-up LCDs. */
function ChannelHero({ ch, hideKicker }: { ch: ChannelId; hideKicker?: boolean }) {
  const info = CHANNEL_INFO[ch]
  return (
    <div className="center" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!hideKicker && <div className="t-px-s faint" style={{ fontSize: 9 }}>YOU ARE</div>}
      <div className="t-px-l ink">{info.name}</div>
      <Wave ch={ch} />
      <div className="t-vt faint">{info.wave} · {info.game.toUpperCase()}</div>
    </div>
  )
}

function Wave({ ch }: { ch: ChannelId }) {
  const d =
    ch === 'lead'
      ? 'M2 26 V4 H22 V26 H42 V4 H62 V26 H82 V4 H102 V26 H122 V4 H128'
      : ch === 'bass'
        ? 'M2 26 L22 4 L42 26 L62 4 L82 26 L102 4 L122 26 L128 19'
        : 'M2 15 L8 6 L12 22 L18 10 L22 18 L28 3 L34 24 L40 12 L46 17 L52 5 L58 25 L64 9 L70 20 L76 7 L82 23 L88 13 L94 18 L100 4 L106 26 L112 11 L118 19 L124 8 L128 15'
  return (
    <svg className="wave" viewBox="0 0 130 30" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinejoin="miter" aria-hidden>
      <path d={d} />
    </svg>
  )
}

/** Five LCD hearts; the last-lost one shows as an outline. */
function Hearts({ health }: { health: number }) {
  const full = Math.max(0, Math.min(5, Math.ceil(health / 20 - 0.001)))
  return (
    <div className="hearts">
      <span className="hp">HP</span>
      {Array.from({ length: 5 }, (_, i) => (
        <svg key={i} viewBox="0 0 24 22" className={i < full ? '' : 'empty'}>
          <path
            d="M12 21 L2 11 C-1 7 1 1 6.5 1 C9 1 11 3 12 5 C13 3 15 1 17.5 1 C23 1 25 7 22 11 Z"
            fill={i < full ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={i < full ? 0 : 2}
          />
        </svg>
      ))}
    </div>
  )
}

/** Re-renders the calibration screen while the clicks play so the "CLICK n OF 8" line keeps up. */
function CalibTicker() {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), 100)
    return () => clearInterval(id)
  }, [])
  return null
}

/** Slide the thumb across to insert the cart. A tap on the track works too. */
function SlideToInsert({ onDone }: { onDone: () => void }) {
  const [x, setX] = useState(0)
  const drag = useRef<{ start: number; max: number } | null>(null)
  return (
    <div
      className="slider"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        drag.current = { start: e.clientX - x, max: r.width - 68 }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) setX(Math.max(0, Math.min(d.max, e.clientX - d.start)))
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        if (d && (x > d.max * 0.6 || x < 4)) {
          setX(d.max)
          setTimeout(onDone, 180)
        } else setX(0)
      }}
    >
      slide to insert
      <div className="slider-thumb" style={{ transform: `translateX(${x}px)`, transition: drag.current ? 'none' : 'transform .2s' }}><Chevrons right /></div>
    </div>
  )
}

/**
 * 3-2-1 for the lead-in, drawn on the LCD over the game, on the host's count-in beats (with quiet blips).
 * It's opaque at first, then clears over the last second so the first notes are visible as they arrive.
 */
function Countdown({ net, startAt, beat, sfx, title, channel }: { net: Net; startAt: number; beat: number; sfx: PhoneSfx; title: string; channel: string }) {
  const [view, setView] = useState<{ n: number; bg: number } | null>(null)
  useEffect(() => {
    let raf = 0
    let lastBeat = Infinity
    const loop = () => {
      const t = (net.serverNow() - startAt) / 1000
      if (t > 0.5) return setView(null)
      raf = requestAnimationFrame(loop)
      const b = Math.ceil(-t / beat)
      setView({ n: t >= 0 ? 0 : b, bg: Math.max(0, Math.min(1, (-t - 1) / 0.6)) })
      if (b < lastBeat && b >= 1 && b <= 3) sfx.blip(b === 1)
      lastBeat = Math.min(lastBeat, b)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [net, startAt, beat, sfx])
  if (!view) return null
  const label = view.n === 0 ? 'GO!' : view.n > 3 ? 'GET READY' : String(view.n)
  return (
    <div className="lcd-count" style={{ '--bg': view.bg } as React.CSSProperties}>
      <div className="t-px-s faint">{title}</div>
      <div key={label} className={`big ${label.length > 1 ? 'word' : ''}`}>{label}</div>
      <div className="count-boxes">
        {[0, 1, 2].map((k) => <i key={k} className={view.n === 0 || (view.n <= 3 && k < 4 - view.n) ? 'on' : ''} />)}
      </div>
      <div className="t-vt">YOU'RE ON {channel} · GET READY</div>
    </div>
  )
}
