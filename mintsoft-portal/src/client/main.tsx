import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'

/**
 * Only set for local work. In a deployed build this is empty and App asks the server,
 * which is what stops a build that forgot the variable from shipping a sign-in page
 * whose Google button has no client id.
 */
const buildTimeClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

const root = document.getElementById('root')
if (!root) throw new Error('No #root element to mount into')

createRoot(root).render(
  <StrictMode>
    <App googleClientId={buildTimeClientId} />
  </StrictMode>,
)
