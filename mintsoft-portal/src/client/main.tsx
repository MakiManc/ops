import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'

// Set at build time from the Pages project's environment.
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

const root = document.getElementById('root')
if (!root) throw new Error('No #root element to mount into')

createRoot(root).render(
  <StrictMode>
    <App googleClientId={googleClientId} />
  </StrictMode>,
)
