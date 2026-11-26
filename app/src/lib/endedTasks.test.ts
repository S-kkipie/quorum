import { describe, expect, it } from 'vitest'
import { endedTasksOf } from './endedTasks'
import type { Event } from '../proto.gen'

const end = (seq: number, taskId: string, o: object = {}): Event => ({ seq, session: 'a', ts: seq, kind: 'task_end', data: { taskId, kind: 'command', summary: 's' + taskId, status: 'completed', ...o } })

describe('endedTasksOf', () => {
  it('lists task_end events newest first and ignores other events', () => {
    const evs: Event[] = [end(1, 'x'), { seq: 2, session: 'a', ts: 2, kind: 'assistant', data: {} }, end(3, 'y')]
    expect(endedTasksOf(evs).map((t) => t.taskId)).toEqual(['y', 'x'])
  })
  it('a real end replaces a synthetic end of the same task', () => {
    const evs = [end(1, 'x', { status: 'stopped', synthetic: true }), end(2, 'y'), end(3, 'x', { status: 'failed', exitCode: 2 })]
    const r = endedTasksOf(evs)
    expect(r.map((t) => [t.taskId, t.status])).toEqual([['x', 'failed'], ['y', 'completed']])
  })
  it('a synthetic end after a real one is ignored', () => {
    const r = endedTasksOf([end(1, 'x'), end(2, 'x', { status: 'stopped', synthetic: true })])
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe('completed')
  })
})
