import { describe, expect, it } from 'vitest'
import { factLine, isDead, type TaskFacts } from './taskOutput'

const item = { id: 'b1', kind: 'command', label: 'sleep 60', startedAt: 1 }
const facts = (o: Partial<TaskFacts> = {}): TaskFacts => ({ found: true, size: 10, mtime: 1_000_000, tail: '', procsKnown: true, procs: [{ pid: 7, state: 'S', cpuMs: 2100 }], ...o })

describe('isDead', () => {
  it('a closed session is dead', () => expect(isDead(item, undefined, 'closed')).toBe(true))
  it('known processes, found output and none left is dead', () => expect(isDead(item, facts({ procs: [] }), 'idle')).toBe(true))
  it('output not found is not dead', () => expect(isDead(item, facts({ found: false, procs: [] }), 'idle')).toBe(false))
  it('unknown processes are not dead', () => expect(isDead(item, facts({ procsKnown: false, procs: [] }), 'idle')).toBe(false))
  it('a live process is not dead', () => expect(isDead(item, facts(), 'idle')).toBe(false))
  it('no facts yet is not dead', () => expect(isDead(item, undefined, 'idle')).toBe(false))
})

describe('factLine', () => {
  const now = 1_000_000 + 3 * 60_000
  it('joins output age, state and CPU', () => expect(factLine(facts(), now)).toBe('last output 3 min ago · sleeping · 2.1 s CPU'))
  it('maps state letters and shows others raw', () => {
    const st = (s: string) => factLine(facts({ procs: [{ pid: 1, state: s, cpuMs: 0 }] }), now)
    expect(st('R')).toContain('running')
    expect(st('D')).toContain('disk wait')
    expect(st('Z')).toContain('zombie')
    expect(st('T')).toContain('stopped')
    expect(st('X')).toContain(' X ')
  })
  it('shows the most active state across processes', () => {
    const procs = (...s: string[]) => s.map((state, i) => ({ pid: i + 1, state, cpuMs: 1000 }))
    expect(factLine(facts({ procs: procs('S', 'R', 'Z') }), now)).toContain('running')
    expect(factLine(facts({ procs: procs('Z', 'S') }), now)).toContain('sleeping')
    expect(factLine(facts({ procs: procs('X', 'Z') }), now)).toContain('zombie')
    expect(factLine(facts({ procs: procs('S', 'R') }), now)).toContain('2.0 s CPU')
  })
  it('omits the process part when processes are unknown or gone', () => {
    expect(factLine(facts({ procsKnown: false, procs: [] }), now)).toBe('last output 3 min ago')
    expect(factLine(facts({ procs: [] }), now)).toBe('last output 3 min ago')
  })
  it('says so when there is no output yet', () => expect(factLine(facts({ found: false }), now)).toBe('no output yet'))
})
