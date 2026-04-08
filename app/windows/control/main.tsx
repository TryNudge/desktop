import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../main.css'
import { initWindow } from '../../lib/init'
import App from './App'
initWindow()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
