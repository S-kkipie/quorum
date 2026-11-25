import { expect, test } from 'claude-code/testing'

import { Link, type LinkIO } from '../src/link'
import { PENDING_TOOLS, runPendingTool } from '../src/pendings'
import type { SessionInfo } from '../src/proto.gen'

type Reply = { status: number; json?: unknown }

async function setup(replies: Reply[]) {
  const calls: Array<{ method: string; url: string; body: any }> = []
  const io: LinkIO = {
    run: async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, port: 7, token: 'tok', machine: 'm' }) }),
    fetch: async (url, init) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined })
      if (url.endsWith('/register')) return { status: 204 }
      const r = replies.shift() ?? { status: 500 }
      return { status: r.status, text: r.json === undefined ? '' : JSON.stringify(r.json) }
    },
    async *spawn() { await new Promise(() => {}) },
    sleep: () => new Promise(() => {}),
  }
  const link = new Link(io)
  await link.start({ id: 's1', role: 'work' } as SessionInfo)
  calls.length = 0
  return { link, calls }
}

const added = { projectName: 'Zorvan', created: true, item: { id: 'p1', text: 'Ask Quillon' } }

test('declares the three tools', () => {
  expect(PENDING_TOOLS.map(t => t.name)).toEqual(['pending_add', 'pending_list', 'pending_done'])
})

test('adds with a client key and retries once with the same key on 502', async () => {
  const { link, calls } = await setup([{ status: 502, json: { error: 'Quorum hub unreachable; the item was not saved' } }, { status: 200, json: added }])
  const r = await runPendingTool(link, 's1', 'pending_add', { text: 'Ask Quillon', detail: 'why' }, () => 'k1')
  expect(r).toMatchObject({ ok: true, text: 'Added to Zorvan: "Ask Quillon" (id p1)' })
  expect(calls.length).toBe(2)
  expect(calls[0]!.body).toEqual({ text: 'Ask Quillon', detail: 'why', clientKey: 'k1' })
  expect(calls[1]!.body.clientKey).toBe('k1')
  expect(calls[0]!.url).toBe('http://127.0.0.1:7/v1/sessions/s1/pendings')
})

test('reports "Already pending" when created is false', async () => {
  const { link } = await setup([{ status: 200, json: { ...added, created: false } }])
  const r = await runPendingTool(link, 's1', 'pending_add', { text: 'Ask Quillon' }, () => 'k')
  expect(r.text).toBe('Already pending in Zorvan: "Ask Quillon" (id p1)')
})

test('passes the no-project error verbatim', async () => {
  const { link } = await setup([{ status: 409, json: { error: 'session has no project' } }])
  const r = await runPendingTool(link, 's1', 'pending_add', { text: 'x' }, () => 'k')
  expect(r).toEqual({ ok: false, text: 'session has no project' })
})

test('list formats items and the empty case', async () => {
  const { link, calls } = await setup([
    { status: 200, json: { projectName: 'Zorvan', items: [{ id: 'a', text: 'One', detail: 'ctx' }, { id: 'b', text: 'Two', detail: '' }] } },
    { status: 200, json: { projectName: 'Zorvan', items: [] } },
  ])
  const r = await runPendingTool(link, 's1', 'pending_list', {}, () => 'k')
  expect(r.text).toBe('- [a] One — ctx\n- [b] Two')
  expect(calls[0]!.method).toBe('GET')
  expect(calls[0]!.url).toContain('?status=open')
  const e = await runPendingTool(link, 's1', 'pending_list', {}, () => 'k')
  expect(e.text).toBe('No open pending items in Zorvan.')
})

test('done sends the note', async () => {
  const { link, calls } = await setup([{ status: 200, json: { item: { id: 'a', text: 'One' } } }])
  const r = await runPendingTool(link, 's1', 'pending_done', { id: 'a', note: 'sent' }, () => 'k')
  expect(r).toMatchObject({ ok: true, text: 'Marked done: "One"' })
  expect(calls[0]!.url).toBe('http://127.0.0.1:7/v1/sessions/s1/pendings/a/done')
  expect(calls[0]!.body).toEqual({ note: 'sent' })
})

test('not connected gives the not-saved message', async () => {
  const link = new Link({ run: async () => ({ exitCode: 1, stdout: '' }), fetch: async () => ({ status: 0 }), async *spawn() {}, sleep: () => new Promise(() => {}) })
  const r = await runPendingTool(link, 's1', 'pending_add', { text: 'x' }, () => 'k')
  expect(r).toEqual({ ok: false, text: 'Quorum is not connected; the item was not saved' })
})
