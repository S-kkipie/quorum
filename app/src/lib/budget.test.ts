import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// The built app (npm run build writes it into the hub); skipped until a build exists.
const DIST = resolve(import.meta.dirname, '../../../internal/hub/web/dist')
const INITIAL_JS_MAX = 655_000

/** Initial JS: the entry script plus every chunk index.html modulepreloads. */
function initialJs(): { bytes: number; files: string[] } {
  const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')
  const files = [...new Set([...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]))]
  return { bytes: files.reduce((n, f) => n + statSync(resolve(DIST, f)).size, 0), files }
}

describe('bundle budget', () => {
  it.skipIf(!existsSync(resolve(DIST, 'index.html')))('initial JS stays at 655 kB or less; the briefing and the meeting UI are not in it', () => {
    const { bytes, files } = initialJs()
    expect(bytes).toBeLessThanOrEqual(INITIAL_JS_MAX)
    for (const f of files) {
      const js = readFileSync(resolve(DIST, f), 'utf8')
      expect(js).not.toContain('Written by Haiku from')
      // the meeting page, its API and Settings → Meetings load on first use
      for (const s of ['Re-summarise with names', 'How many people?', '/api/settings/meetings', '/api/meetings/uploads', 'Names I go by', 'Transcription waiting for', '/live/stop', 'audio/webm;codecs=opus']) expect(js).not.toContain(s)
    }
  })
})
