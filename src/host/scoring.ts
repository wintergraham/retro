import type { Award, ChannelId, GameResults, Judgement, PlayerInfo, PlayerResult } from '../../shared/protocol'
import { resultRoast } from '../../shared/roasts'

import type { Chart } from '../../shared/songs'

const GRACE = 4 // seconds at the start where misses don't cost health
const WEIGHT = { perfect: 1, good: 0.6, miss: 0 }
/**
 * Health per second one channel moves when every judgement it makes is a miss / perfect / good. Each
 * channel's share is split by player count and spread over its own note density, so a dense chart
 * doesn't hurt more than a sparse one: a fully idle team (any size) dies about 18s after the grace
 * period, while roughly 60% hits or better survives the song.
 */
const RATE = { miss: -5.5, perfect: 2, good: 0.8 }

/** Judgements per second a channel makes in this chart (bass is judged once per beat). */
export function judgeRate(chart: Chart, ch: ChannelId) {
  const n = ch === 'lead' ? chart.lead.length : ch === 'drums' ? chart.drums.length : Math.round(chart.duration / chart.beat)
  return n / chart.duration
}

interface Stats {
  perfect: number
  good: number
  miss: number
  combo: number
  maxCombo: number
  /** Misses in a row right now. */
  missStreak: number
}

const WEAK_WINDOW = 8 // seconds of history for the WEAKEST LINK badge

/** Team health, per-player stats, rank and the end-of-song awards. */
export class Scoreboard {
  health = 100
  teamCombo = 0
  stats = new Map<string, Stats>()
  /** Song times of recent misses per player, for the rolling weakest-link window. */
  private recentMisses = new Map<string, number[]>()
  /** Health change per judgement, per player. */
  private delta = new Map<string, Record<Judgement, number>>()

  constructor(private players: PlayerInfo[], chart: Chart) {
    for (const p of players) {
      this.stats.set(p.id, { perfect: 0, good: 0, miss: 0, combo: 0, maxCombo: 0, missStreak: 0 })
      const per = 1 / (players.length * judgeRate(chart, p.channel as ChannelId))
      this.delta.set(p.id, { perfect: RATE.perfect * per, good: RATE.good * per, miss: RATE.miss * per })
    }
  }

  judge(playerId: string, r: Judgement, songTime: number) {
    const s = this.stats.get(playerId)
    if (!s) return
    s[r]++
    if (r === 'miss') {
      s.combo = 0
      s.missStreak++
      this.teamCombo = 0
      const list = this.recentMisses.get(playerId) ?? []
      list.push(songTime)
      this.recentMisses.set(playerId, list)
    } else {
      s.missStreak = 0
      s.combo++
      s.maxCombo = Math.max(s.maxCombo, s.combo)
      this.teamCombo++
    }
    if (r === 'miss' && songTime < GRACE) return
    this.health = Math.max(0, Math.min(100, this.health + this.delta.get(playerId)![r]))
  }

  /**
   * Who's dragging the band down: most misses over the last few seconds (ties go to the longer
   * current miss streak). Null with fewer than two players or when nobody has missed lately.
   */
  weakest(songTime: number): string | null {
    if (this.players.length < 2) return null
    let worst: string | null = null
    let worstScore = 0
    for (const p of this.players) {
      const list = (this.recentMisses.get(p.id) ?? []).filter((t) => t > songTime - WEAK_WINDOW)
      this.recentMisses.set(p.id, list)
      const score = list.length + this.stats.get(p.id)!.missStreak * 0.01
      if (list.length && score > worstScore) {
        worst = p.id
        worstScore = score
      }
    }
    return worst
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
        roast: '',
      }
    })
    // Top of the table gets a backhanded compliment, bottom gets roasted, the rest get shrugged at.
    const ranked = [...players].sort((a, b) => b.accuracy - a.accuracy)
    ranked.forEach((p, i) => {
      const tier =
        players.length === 1
          ? p.accuracy >= 0.75 ? 'best' : p.accuracy < 0.5 ? 'worst' : 'mid'
          : i === 0 ? 'best' : i === ranked.length - 1 ? 'worst' : 'mid'
      p.roast = resultRoast(tier)
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
