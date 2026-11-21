export const CHANNELS = ['lead', 'bass', 'drums'] as const
export type ChannelId = (typeof CHANNELS)[number]
/** Synth voices: the three player channels plus the arp, which the CPU always plays. */
export type VoiceId = ChannelId | 'arp'

export const CHANNEL_INFO: Record<ChannelId, { name: string; wave: string; game: string; color: string; howTo: string }> = {
  lead: { name: 'LEAD', wave: 'PULSE 1', game: 'Piano Tiles', color: '#e4572e', howTo: 'Tap the tiles as they hit the line.' },
  bass: { name: 'BASS', wave: 'TRIANGLE', game: 'Tilt Ship', color: '#5ba35a', howTo: 'Tilt (or drag) to keep your ship on the bassline.' },
  drums: { name: 'DRUMS', wave: 'NOISE', game: 'Timing Rings', color: '#3a8fc4', howTo: 'Smash a pad when its ring closes in.' },
}

/** Longer how-to shown on the ready-up card. */
export const CHANNEL_STEPS: Record<ChannelId, string[]> = {
  lead: ['Tiles fall down 4 lanes.', 'Tap a lane as its tile reaches the line.', 'Long tiles are holds: keep your finger down to the end.'],
  bass: ['Your ship flies up the bassline.', 'Tilt the phone left and right to steer, or drag a finger.', 'Drift off the glowing core and the bass goes out of tune.'],
  drums: ['Three pads: KICK, SNARE and TOM.', 'A ring shrinks onto a pad.', 'Hit the pad the moment its ring closes.'],
}

export const ARP_INFO = { name: 'ARP', wave: 'PULSE 2', color: '#f3a712' }

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
  roast: string
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
  /** `resume` reclaims a room after a host reload or dropped connection; `keep` says this page still has the game state. */
  | { t: 'host:create'; resume?: { code: string; key: string }; keep?: boolean }
  | { t: 'host:ready'; songId: string }
  | { t: 'host:start'; songId: string }
  | { t: 'host:hud'; health: number; combo: number; weakest: string | null; roast: string | null }
  | { t: 'host:end'; results: GameResults }
  | { t: 'host:lobby' }
  | { t: 'join'; code: string; name: string; playerId?: string }
  | { t: 'pick'; channel: ChannelId }
  | { t: 'judge'; r: Judgement }
  | { t: 'bend'; v: number }
  | { t: 'calib' }
  | { t: 'ready'; on: boolean }
  /** The phone's LEAVE button: give the seat back for good. */
  | { t: 'leave' }

export type ServerMsg =
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; msg: string }
  | { t: 'room'; code: string; key: string }
  | { t: 'joined'; code: string; playerId: string }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'start'; songId: string; startAt: number }
  | { t: 'judge'; playerId: string; r: Judgement }
  | { t: 'bend'; playerId: string; v: number }
  | { t: 'hud'; health: number; combo: number; weakest: string | null; roast: string | null }
  | { t: 'ready'; songId: string; ready: string[] }
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
