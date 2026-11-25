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

const added = { projectName: 'Zorvan', created: true, projectId: 'pr1', item: { id: 'p1', text: 'Ask Quillon' } }

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

test('a retry that answers created:false still reports "Added to"; a double 502 fails with the not-saved text', async () => {
  const a = await setup([{ status: 0 }, { status: 200, json: { ...added, created: false } }])
  expect((await runPendingTool(a.link, 's1', 'pending_add', { text: 'Ask Quillon' }, () => 'k')).text).toBe('Added to Zorvan: "Ask Quillon" (id p1)')
  const b = await setup([{ status: 502, json: { error: 'x' } }, { status: 502, json: { error: 'x' } }])
  expect(await runPendingTool(b.link, 's1', 'pending_add', { text: 'x' }, () => 'k')).toEqual({ ok: false, text: 'Quorum hub unreachable; the item was not saved' })
  expect(b.calls.length).toBe(2)
})

test('error wording per tool and status', async () => {
  const run = async (tool: string, rep: Reply, input: Record<string, unknown> = { text: 'x', id: 'a' }) =>
    (await runPendingTool((await setup([rep, rep])).link, 's1', tool, input, () => 'k')).text
  expect(await run('pending_list', { status: 502, json: { error: 'x' } })).toBe('Quorum hub unreachable; could not list pending items')
  expect(await run('pending_done', { status: 502, json: { error: 'x' } })).toBe('Quorum hub unreachable; the item was not marked done')
  expect(await run('pending_list', { status: 404, json: { error: 'unknown session' } })).toBe('unknown session (Quorum has not seen this session yet; try again in a few seconds)')
  expect(await run('pending_list', { status: 401, json: { error: 'unauthorized' } })).toBe('Quorum rejected this machine; re-link it with `quorumd link`')
  expect(await run('pending_done', { status: 403 })).toBe('Quorum rejected this machine; re-link it with `quorumd link`')
  expect(await run('pending_list', { status: 404 })).toBe('This Quorum version does not support pending items yet; update quorumd and the hub')
  expect(await run('pending_done', { status: 404, json: { error: 'pending item not found' } })).toBe('pending item not found')
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

test('list shows status and note, keeps full detail, and notes truncation', async () => {
  const long = 'd'.repeat(200)
  const { link } = await setup([
    { status: 200, json: { projectName: 'Zorvan', total: 7, items: [
      { id: 'a', text: 'One', detail: long, status: 'open', note: '' },
      { id: 'b', text: 'Two', detail: 'ctx', status: 'done', note: 'sent  it' },
    ] } },
  ])
  const r = await runPendingTool(link, 's1', 'pending_list', { status: 'all' }, () => 'k')
  expect(r.text).toBe(`- [a] One — ${long}\n- [b] (done) Two — ctx · Note: sent it\n(showing 2 of 7)`)
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
