import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => 'x', setItem() {}, removeItem() {} })
class FakeWS {
  static OPEN = 1
  readyState = 0
  onopen: any; onmessage: any; onclose: any; onerror: any
  static all: FakeWS[] = []
  constructor(public url: string) { FakeWS.all.push(this) }
  send() {}
  close() { this.onclose?.() }
}
vi.stubGlobal('WebSocket', FakeWS)
const fetchMock = vi.fn(async () => new Response('[]'))
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('location', { origin: 'http://h' })
import { connectLive } from './live'

describe('connectLive', () => {
  it('checks the token only once per drop', async () => {
    vi.useFakeTimers()
    const l = connectLive(() => {})
    for (let i = 0; i < 6; i++) {
      FakeWS.all[FakeWS.all.length - 1].close()
      await vi.advanceTimersByTimeAsync(16000)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    l.close()
    vi.useRealTimers()
  })
})

describe('connectLive backoff', () => {
  it('after connecting successfully it waits 1 s again', async () => {
    vi.useFakeTimers()
    FakeWS.all = []
    const l = connectLive(() => {})
    const last = () => FakeWS.all[FakeWS.all.length - 1]
    last().close() // waits 1 s
    await vi.advanceTimersByTimeAsync(1000)
    last().close() // waits 2 s
    await vi.advanceTimersByTimeAsync(2000)
    last().close() // waits 4 s
    await vi.advanceTimersByTimeAsync(4000)
    const n = FakeWS.all.length
    last().onopen() // healthy connection: resets the backoff
    last().close()
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWS.all.length).toBe(n)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWS.all.length).toBe(n + 1)
    l.close()
    vi.useRealTimers()
  })
})
