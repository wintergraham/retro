import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { CALIB, CHANNELS, LEAD_IN_MS, type ChannelId, type ClientMsg, type PlayerInfo, type ServerMsg } from '../shared/protocol.ts'

const PORT = Number(process.env.PORT ?? 3001)
const PROD = process.env.NODE_ENV === 'production'
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))

interface Player extends PlayerInfo {
  ws: WebSocket | null
}

interface Room {
  code: string
  host: WebSocket | null
  players: Map<string, Player>
  phase: 'lobby' | 'playing' | 'results'
  start: { songId: string; startAt: number } | null
}

const rooms = new Map<string, Room>()
const socketRoom = new WeakMap<WebSocket, { room: Room; playerId?: string }>()

function send(ws: WebSocket | null | undefined, msg: ServerMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function toPlayers(room: Room): PlayerInfo[] {
  return [...room.players.values()].map(({ id, name, channel, connected }) => ({ id, name, channel, connected }))
}

function broadcastPlayers(room: Room) {
  const msg: ServerMsg = { t: 'players', players: toPlayers(room) }
  send(room.host, msg)
  for (const p of room.players.values()) send(p.ws, msg)
}

function toPlayersOnly(room: Room, msg: ServerMsg) {
  for (const p of room.players.values()) send(p.ws, msg)
}

function newCode(): string {
  // No I/O/0/1 so codes are easy to read off a TV.
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  let code
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('')
  while (rooms.has(code))
  return code
}

function freeChannel(room: Room): ChannelId | null {
  const taken = new Set([...room.players.values()].map((p) => p.channel))
  return CHANNELS.find((c) => !taken.has(c)) ?? null
}

function handle(ws: WebSocket, msg: ClientMsg) {
  const ctx = socketRoom.get(ws)

  switch (msg.t) {
    case 'ping':
      return send(ws, { t: 'pong', c: msg.c, s: Date.now() })

    case 'host:create': {
      const room: Room = { code: newCode(), host: ws, players: new Map(), phase: 'lobby', start: null }
      rooms.set(room.code, room)
      socketRoom.set(ws, { room })
      send(ws, { t: 'room', code: room.code })
      return broadcastPlayers(room)
    }

    case 'join': {
      const room = rooms.get(msg.code.toUpperCase().trim())
      if (!room) return send(ws, { t: 'error', msg: 'Room not found' })
      const existing = msg.playerId ? room.players.get(msg.playerId) : undefined
      if (existing) {
        existing.ws?.close()
        existing.ws = ws
        existing.connected = true
        if (msg.name) existing.name = msg.name.slice(0, 12)
        socketRoom.set(ws, { room, playerId: existing.id })
        send(ws, { t: 'joined', code: room.code, playerId: existing.id })
        broadcastPlayers(room)
        // Back in mid-song (reload, wifi blip): drop straight into the running song.
        if (room.phase === 'playing' && room.start) send(ws, { t: 'start', ...room.start })
        return
      }
      if (room.phase === 'playing') return send(ws, { t: 'error', msg: 'Song in progress, hang tight' })
      const channel = freeChannel(room)
      if (!channel) return send(ws, { t: 'error', msg: 'All 4 channels are taken' })
      const player: Player = {
        id: Math.random().toString(36).slice(2, 10),
        name: (msg.name || 'PLAYER').slice(0, 12).toUpperCase(),
        channel,
        connected: true,
        ws,
      }
      room.players.set(player.id, player)
      socketRoom.set(ws, { room, playerId: player.id })
      send(ws, { t: 'joined', code: room.code, playerId: player.id })
      return broadcastPlayers(room)
    }
  }

  if (!ctx) return
  const { room, playerId } = ctx
  const isHost = room.host === ws
  const player = playerId ? room.players.get(playerId) : undefined

  switch (msg.t) {
    case 'pick': {
      if (!player || room.phase === 'playing') return
      const owner = [...room.players.values()].find((p) => p.channel === msg.channel)
      if (owner && owner !== player) owner.channel = player.channel // swap
      player.channel = msg.channel
      return broadcastPlayers(room)
    }
    case 'host:start': {
      if (!isHost) return
      room.phase = 'playing'
      room.start = { songId: msg.songId, startAt: Date.now() + LEAD_IN_MS }
      const startMsg: ServerMsg = { t: 'start', ...room.start }
      send(room.host, startMsg)
      return toPlayersOnly(room, startMsg)
    }
    case 'host:hud':
      if (isHost) toPlayersOnly(room, { t: 'hud', health: msg.health, combo: msg.combo })
      return
    case 'host:end':
      if (!isHost) return
      room.phase = 'results'
      return toPlayersOnly(room, { t: 'end', results: msg.results })
    case 'host:lobby':
      if (!isHost) return
      room.phase = 'lobby'
      room.start = null
      // Phones that dropped mid-song were holding their channel for a rejoin; free it now.
      for (const p of room.players.values()) if (!p.connected) room.players.delete(p.id)
      toPlayersOnly(room, { t: 'lobby' })
      return broadcastPlayers(room)
    case 'judge':
      if (player) send(room.host, { t: 'judge', playerId: player.id, r: msg.r })
      return
    case 'bend':
      if (player) send(room.host, { t: 'bend', playerId: player.id, v: msg.v })
      return
    case 'calib': {
      if (!player || room.phase === 'playing') return
      const calibMsg: ServerMsg = { t: 'calib', playerId: player.id, startAt: Date.now() + CALIB.leadInMs }
      send(room.host, calibMsg)
      return send(ws, calibMsg)
    }
  }
}

function onClose(ws: WebSocket) {
  const ctx = socketRoom.get(ws)
  if (!ctx) return
  const { room, playerId } = ctx
  if (room.host === ws) {
    room.host = null
    toPlayersOnly(room, { t: 'host-left' })
    rooms.delete(room.code)
    return
  }
  const player = playerId ? room.players.get(playerId) : undefined
  if (!player || player.ws !== ws) return
  player.ws = null
  player.connected = false
  // In the lobby a dropped phone frees its channel; mid-song it keeps the slot so it can rejoin.
  if (room.phase !== 'playing') room.players.delete(player.id)
  broadcastPlayers(room)
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address)
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ lan: lanAddresses() }))
  }
  if (!PROD) {
    res.writeHead(404)
    return res.end('Run the web app through Vite in dev (npm run dev).')
  }
  // SPA static serving for production builds.
  const path = normalize(join(DIST, url.pathname)).startsWith(DIST) ? join(DIST, url.pathname) : DIST
  for (const file of [path, join(DIST, 'index.html')]) {
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      return res.end(body)
    } catch {}
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: http, path: '/ws' })
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      handle(ws, JSON.parse(String(data)) as ClientMsg)
    } catch (err) {
      console.error('bad message', err)
    }
  })
  ws.on('close', () => onClose(ws))
})

http.listen(PORT, () => {
  console.log(`chip squad server on :${PORT}  (LAN: ${lanAddresses().join(', ') || 'none'})`)
})
