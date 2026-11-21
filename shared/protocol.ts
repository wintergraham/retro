export const CHANNELS = ['lead', 'bass', 'drums', 'arp'] as const
export type ChannelId = (typeof CHANNELS)[number]

export const CHANNEL_INFO: Record<ChannelId, { name: string; wave: string; game: string; color: string; howTo: string }> = {
  lead: { name: 'LEAD', wave: 'PULSE 1', game: 'Piano Tiles', color: '#ff4fa3', howTo: 'Tap the tiles as they hit the line.' },
  bass: { name: 'BASS', wave: 'TRIANGLE', game: 'Tilt Ship', color: '#3ef0ff', howTo: 'Tilt (or drag) to keep your ship on the bassline.' },
  drums: { name: 'DRUMS', wave: 'NOISE', game: 'Timing Rings', color: '#ffd23f', howTo: 'Smash a pad when its ring closes in.' },
  arp: { name: 'ARP', wave: 'PULSE 2', game: 'Connect Dots', color: '#5dff7a', howTo: 'Swipe the dots in order before the bar ends.' },
}

export type Judgement = 'perfect' | 'good' | 'miss'

export interface PlayerInfo {
  id: string
  name: string
  channel: ChannelId | null
  connected: boolean
}

export interface PlayerResult {
  id: string
  name: string
  channel: ChannelId
  perfect: number
  good: number
  miss: number
  maxCombo: number
  accuracy: number
}

export interface Award {
  title: string
  playerId: string
  name: string
  blurb: string
}

export interface GameResults {
  songId: string
  cleared: boolean
  rank: 'S' | 'A' | 'B' | 'C' | 'F'
  accuracy: number
  players: PlayerResult[]
  awards: Award[]
}

export type ClientMsg =
  | { t: 'ping'; c: number }
  | { t: 'host:create' }
  | { t: 'host:start'; songId: string }
  | { t: 'host:hud'; health: number; combo: number }
  | { t: 'host:end'; results: GameResults }
  | { t: 'host:lobby' }
  | { t: 'join'; code: string; name: string; playerId?: string }
  | { t: 'pick'; channel: ChannelId }
  | { t: 'judge'; r: Judgement }
  | { t: 'bend'; v: number }
  | { t: 'calib' }

export type ServerMsg =
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; msg: string }
  | { t: 'room'; code: string }
  | { t: 'joined'; code: string; playerId: string }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'start'; songId: string; startAt: number }
  | { t: 'judge'; playerId: string; r: Judgement }
  | { t: 'bend'; playerId: string; v: number }
  | { t: 'hud'; health: number; combo: number }
  | { t: 'end'; results: GameResults }
  | { t: 'lobby' }
  | { t: 'host-left' }
  | { t: 'calib'; playerId: string; startAt: number }

/** Countdown between "start" and the first downbeat, in ms. */
export const LEAD_IN_MS = 4000

/** Hit windows in seconds, shared by every tap-timed game. */
export const WINDOW = { perfect: 0.06, good: 0.13 }

/** Latency calibration: the host clicks `clicks` times, `interval` seconds apart, starting `leadInMs` after the request. */
export const CALIB = { clicks: 8, interval: 0.6, leadInMs: 2500 }
