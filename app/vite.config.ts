/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// emptyOutDir deletes dist/.keep, which the Go embed needs in a clean clone.
const keep = () => ({
  name: 'quorum-keep',
  closeBundle() { writeFileSync(resolve(import.meta.dirname, '../internal/hub/web/dist/.keep'), '') },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), keep()],
  build: { outDir: '../internal/hub/web/dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:7420', ws: true } } },
  test: { environment: 'node' },
})
