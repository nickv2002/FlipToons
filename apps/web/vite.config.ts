import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// packages/engine lives two levels above this app root; Vite's dev server
// otherwise 403s on requests for files outside root (§9: engine stays plain
// TS source, no package build step, so it's imported straight from there).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    fs: {
      allow: ['../..'],
    },
  },
})
