import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// No StrictMode: HostApp opens its room socket and AudioContext once, and a double-invoke would open two rooms.
createRoot(document.getElementById('root')!).render(<App />)
