import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  server: {
    // `wrangler pages dev` serves the API; the dev server proxies to it so the
    // browser talks to one origin and the session cookie behaves as it will in
    // production.
    proxy: { '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true } },
  },
})
