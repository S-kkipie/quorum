import { describe, expect, it, vi } from 'vitest'
import { artifactLinks, artifactPath } from './artifacts'
import type { Event } from '../proto.gen'

const ev = (seq: number, kind: string, data: unknown): Event => ({ seq, session: 's', ts: 1, kind, data })

describe('artifactLinks', () => {
  it('finds /v/ links in tool results and answers and dedupes by URL', () => {
    const out = artifactLinks([
      ev(1, 'tool_end', { id: 'a', ok: true, output: 'saved: /v/ab12cd/report.html' }),
      ev(2, 'assistant', { text: 'See [the report](/v/ab12cd/report.html) and https://hub.example/v/ff00/notes%20x.html.' }),
      ev(3, 'assistant', { text: 'again /v/ab12cd/report.html' }),
    ], 'https://hub.example')
    expect(out).toEqual([
      { title: 'report.html', url: '/v/ab12cd/report.html', eventKey: 'tool:1' },
      { title: 'notes x.html', url: 'https://hub.example/v/ff00/notes%20x.html', eventKey: 'assistant:2' },
    ])
  })
  it('uses the markdown label as title and ignores other URLs', () => {
    const out = artifactLinks([ev(5, 'assistant', { text: '[Q3 summary](/v/0a1b/q3.html) http://x.test/other' })])
    expect(out).toEqual([{ title: 'Q3 summary', url: '/v/0a1b/q3.html', eventKey: 'assistant:5' }])
  })
  it('only bare links and links on the hub origin are artifacts', () => {
    const text = [
      'ours https://hub.example/v/aa11/a.html',
      'theirs https://evil.test/v/bb22/b.html',
      'port http://hub.example:8080/v/cc33/c.html',
      'path /srv/v/dd44/d.html and src/v/ee55/e.html',
      '[label](https://evil.test/v/ff66/f.html)',
      'bare /v/0123/g.html',
    ].join('\n')
    const urls = artifactLinks([ev(1, 'assistant', { text })], 'https://hub.example/').map((l) => l.url)
    expect(urls).toEqual(['https://hub.example/v/aa11/a.html', '/v/0123/g.html'])
  })
  it('with no hub address the page origin is the hub', () => {
    vi.stubGlobal('location', { origin: 'https://served.example' })
    try {
      const own = 'https://served.example/v/aa11/a.html'
      const urls = artifactLinks([ev(1, 'assistant', { text: `${own} https://evil.test/v/bb22/b.html` })]).map((l) => l.url)
      expect(urls).toEqual([own])
    } finally { vi.unstubAllGlobals() }
  })
  it('finds links in a subagent\'s task and answer (the Agent call is its card)', () => {
    const out = artifactLinks([
      ev(1, 'tool_start', { id: 'tu', name: 'Agent', summary: '', input: { description: 'd', prompt: 'Update /v/aa11/brief.md' } }),
      ev(2, 'agent_start', { id: 'ag', type: 'x', description: 'd', tool: 'tu' }),
      ev(3, 'agent_end', { id: 'ag', status: 'completed', answer: 'Wrote /v/bb22/out.html' }),
      ev(4, 'tool_end', { id: 'tu', ok: true, output: 'Wrote /v/bb22/out.html' }),
    ])
    expect(out.map((l) => [l.url, l.eventKey])).toEqual([['/v/aa11/brief.md', 'agent:1'], ['/v/bb22/out.html', 'agent:1']])
  })
})

describe('artifactPath', () => {
  it('maps a /v/ link to the file under the session base', () => {
    expect(artifactPath('/v/ab12/.claude/quorum/artifacts/q3%20plan.html', '/home/u/proj')).toBe('/home/u/proj/.claude/quorum/artifacts/q3 plan.html')
    expect(artifactPath('https://hub.example/v/ab12/r.html?x=1', '/home/u/proj/')).toBe('/home/u/proj/r.html')
    expect(artifactPath('/v/ab12/a/r.html', 'C:\\Users\\u\\proj')).toBe('C:\\Users\\u\\proj\\a\\r.html')
  })
  it('refuses links it cannot map', () => {
    expect(artifactPath('/v/ab12/r.html', '')).toBe('')
    expect(artifactPath('/x/ab12/r.html', '/p')).toBe('')
    expect(artifactPath('/v/ab12/../etc/passwd', '/p')).toBe('')
    // a dot segment is resolved first, so the result stays under the base
    expect(artifactPath('/v/ab12/a/%2e%2e/b.html', '/p')).toBe('/p/b.html')
  })
})
