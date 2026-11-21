import type { ClientMsg, ServerMsg } from '../shared/protocol'

type Listener = (msg: ServerMsg) => void

/**
 * WebSocket connection to the room server plus an NTP-style clock sync, so every device
 * can agree on when the song started without streaming audio between phones.
 */
export class Net {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private queue: ClientMsg[] = []
  private samples: { rtt: number; offset: number }[] = []
  private syncTimer = 0
  private onOpen: (() => void) | null = null
  /** serverTime ≈ performance.now() + offset */
  offset = 0
  rtt = 0
  connected = false

  constructor(onOpen?: () => void) {
    this.onOpen = onOpen ?? null
    this.connect()
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      // (Re)join first: anything queued while offline (judgements, host:end) needs the room to land in.
      this.onOpen?.()
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m))
      this.burstSync()
    }
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMsg
      if (msg.t === 'pong') return this.onPong(msg.c, msg.s)
      for (const l of this.listeners) l(msg)
    }
    ws.onclose = () => {
      this.connected = false
      if (this.ws === ws) setTimeout(() => this.connect(), 1000)
    }
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
    else if (msg.t !== 'bend' && msg.t !== 'ping') this.queue.push(msg)
  }

  on(l: Listener) {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }

  close() {
    clearInterval(this.syncTimer)
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  serverNow() {
    return performance.now() + this.offset
  }

  private burstSync() {
    this.samples = []
    for (let i = 0; i < 10; i++) setTimeout(() => this.send({ t: 'ping', c: performance.now() }), i * 120)
    clearInterval(this.syncTimer)
    this.syncTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 3000)
  }

  private onPong(c: number, s: number) {
    const now = performance.now()
    const rtt = now - c
    this.samples.push({ rtt, offset: s + rtt / 2 - now })
    if (this.samples.length > 20) this.samples.shift()
    // The lowest-RTT samples are the least skewed by queueing delay.
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3)
    const target = best.reduce((sum, x) => sum + x.offset, 0) / best.length
    // Settle freely during the connect burst; after that, slew so the song clock never jumps
    // mid-song, unless we're clearly wrong.
    const diff = target - this.offset
    if (this.samples.length <= 10 || Math.abs(diff) > 50) this.offset = target
    else this.offset += Math.max(-2, Math.min(2, diff))
    this.rtt = best[0].rtt
  }
}
