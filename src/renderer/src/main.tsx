import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'

// Apply theme from the URL hash before React mounts to avoid a light flash on
// a dark-mode startup (main process injects `#theme=...`).
const m = location.hash.match(/theme=(light|dark)/)
if (m) document.documentElement.dataset.theme = m[1]

const container = document.getElementById('root')
if (!container) throw new Error('Root container #root not found')

createRoot(container).render(<App />)
