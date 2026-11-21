import { CHANNEL_INFO, type GameResults } from '../shared/protocol'
import { songById } from '../shared/songs'

export function HealthBar({ health }: { health: number }) {
  const segments = 20
  const lit = Math.ceil((health / 100) * segments)
  const color = health > 50 ? '#5dff7a' : health > 25 ? '#ffd23f' : '#ff3b5c'
  return (
    <div className="health">
      <span className="health-label">HP</span>
      <div className="health-segs">
        {Array.from({ length: segments }, (_, i) => (
          <div key={i} className="seg" style={{ background: i < lit ? color : undefined }} />
        ))}
      </div>
    </div>
  )
}

export function Results({ results, me }: { results: GameResults; me?: string }) {
  return (
    <div className="results">
      <div className="dim small">{songById(results.songId).title}</div>
      <div className={`rank rank-${results.rank}`}>{results.rank}</div>
      <div className="cleared">{results.cleared ? 'STAGE CLEAR!' : 'GAME OVER'}</div>
      <div className="dim small">TEAM ACCURACY {Math.round(results.accuracy * 100)}%</div>
      <div className="awards">
        {results.awards.map((a) => (
          <div key={a.title} className={`award ${a.playerId === me ? 'mine' : ''}`}>
            <div className="award-title">★ {a.title}</div>
            <div>{a.name}</div>
            <div className="dim small">{a.blurb}</div>
          </div>
        ))}
      </div>
      <table className="score-table">
        <tbody>
          {results.players.map((p) => (
            <tr key={p.id} className={p.id === me ? 'mine' : ''}>
              <td style={{ color: CHANNEL_INFO[p.channel].color }}>{CHANNEL_INFO[p.channel].name}</td>
              <td>{p.name}</td>
              <td>{Math.round(p.accuracy * 100)}%</td>
              <td className="dim">{p.perfect}/{p.good}/{p.miss}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dim small">PERFECT / GOOD / MISS</div>
    </div>
  )
}
