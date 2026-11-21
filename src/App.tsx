import { HostApp } from './host/HostApp'
import { PhoneApp } from './phone/PhoneApp'

export function App() {
  const path = location.pathname.replace(/\/+$/, '')
  if (path === '/host') return <HostApp />
  if (path === '/play') return <PhoneApp />
  return (
    <div className="screen landing">
      <h1 className="logo">8-BIT<br />CHIP SQUAD</h1>
      <p className="dim small">A 3-player chiptune band. One screen hosts, phones play.</p>
      <div className="landing-buttons">
        <a className="btn big" href="/host">HOST A GAME</a>
        <a className="btn big" href="/play">JOIN</a>
      </div>
    </div>
  )
}
