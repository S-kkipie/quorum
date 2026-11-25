/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prePaintScript } from './src/lib/prepaint'

// emptyOutDir deletes dist/.keep, which the Go embed needs in a clean clone.
const keep = () => ({
  name: 'quorum-keep',
  closeBundle() { writeFileSync(resolve(import.meta.dirname, '../internal/hub/web/dist/.keep'), '') },
})

// The pre-paint theme and palette script (src/lib/prepaint.ts), inlined at the top of <head>.
const prepaint = () => ({
  name: 'quorum-prepaint',
  transformIndexHtml(html: string) {
    if (!html.includes('<!-- prepaint -->')) throw new Error('index.html: missing <!-- prepaint --> placeholder')
    return html.replace('<!-- prepaint -->', `<script>${prePaintScript()}</script>`)
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), keep(), prepaint()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: { outDir: '../internal/hub/web/dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:7420', ws: true } } },
  test: { environment: 'node', setupFiles: ['./src/test-setup.ts'] },
})
