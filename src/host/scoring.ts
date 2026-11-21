import type { Award, ChannelId, GameResults, Judgement, PlayerInfo, PlayerResult } from '../../shared/protocol'

const HEAL = { perfect: 1, good: 0.4, miss: -3 }
const GRACE = 4 // seconds at the start where misses don't cost health
const WEIGHT = { perfect: 1, good: 0.6, miss: 0 }

interface Stats {
  perfect: number
  good: number
  miss: number
  combo: number
  maxCombo: number
}

/** Team health, per-player stats, rank and the end-of-song awards. */
export class Scoreboard {
  health = 100
  teamCombo = 0
  stats = new Map<string, Stats>()

  constructor(private players: PlayerInfo[]) {
    for (const p of players) this.stats.set(p.id, { perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0 })
  }

  judge(playerId: string, r: Judgement, songTime: number) {
    const s = this.stats.get(playerId)
    if (!s) return
    s[r]++
    if (r === 'miss') {
      s.combo = 0
      this.teamCombo = 0
    } else {
      s.combo++
      s.maxCombo = Math.max(s.maxCombo, s.combo)
      this.teamCombo++
    }
    if (r === 'miss' && songTime < GRACE) return
    // Fewer players means each miss hurts less, so a solo run is still survivable.
    const scale = r === 'miss' ? Math.max(0.5, this.players.length / 4) : 1
    this.health = Math.max(0, Math.min(100, this.health + HEAL[r] * scale))
  }

  accuracy(id: string) {
    const s = this.stats.get(id)!
    const total = s.perfect + s.good + s.miss
    return total ? (s.perfect * WEIGHT.perfect + s.good * WEIGHT.good) / total : 0
  }

  results(songId: string, cleared: boolean): GameResults {
    const players: PlayerResult[] = this.players.map((p) => {
      const s = this.stats.get(p.id)!
      return {
        id: p.id,
        name: p.name,
        channel: p.channel as ChannelId,
        perfect: s.perfect,
        good: s.good,
        miss: s.miss,
        maxCombo: s.maxCombo,
        accuracy: this.accuracy(p.id),
      }
    })
    const accuracy = players.length ? players.reduce((a, p) => a + p.accuracy, 0) / players.length : 0
    const rank = !cleared ? 'F' : accuracy >= 0.9 ? 'S' : accuracy >= 0.78 ? 'A' : accuracy >= 0.62 ? 'B' : 'C'
    return { songId, cleared, rank, accuracy, players, awards: awards(players) }
  }
}

function awards(players: PlayerResult[]): Award[] {
  if (!players.length) return []
  const by = (f: (p: PlayerResult) => number) => [...players].sort((a, b) => f(b) - f(a))[0]
  const out: Award[] = []
  const add = (title: string, p: PlayerResult, blurb: string) => out.push({ title, playerId: p.id, name: p.name, blurb })

  const best = by((p) => p.accuracy)
  add('CARRIED THE BAND', best, `${Math.round(best.accuracy * 100)}% accuracy`)
  if (players.length > 1) {
    const worst = by((p) => -p.accuracy)
    if (worst !== best) add('MOST OUT OF TUNE', worst, `${worst.miss} misses. Iconic.`)
  }
  const combo = by((p) => p.maxCombo)
  if (combo.maxCombo >= 10) add('COMBO GOBLIN', combo, `${combo.maxCombo} in a row`)
  const metro = by((p) => p.perfect)
  if (metro.perfect >= 10 && metro !== best) add('HUMAN METRONOME', metro, `${metro.perfect} perfects`)
  return out
}
