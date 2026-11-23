// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Conversations from './Conversations'

const conv = (i: number, open = false) => ({ id: 'c' + i, title: 'Conv ' + i, firstPrompt: '', messages: i, updatedAt: Date.now() - i * 60000, open })
let data: ReturnType<typeof conv>[] = []
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))))
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(cleanup)
const ten = () => Array.from({ length: 10 }, (_, i) => conv(i + 1, i === 0))

describe('Conversations', () => {
  it('shows 6 of 10 and "See all (10)" expands with a search box', async () => {
    data = ten()
    render(<Conversations machine="m" root="/r" liveIds={new Set()} onOpen={vi.fn()} onResume={vi.fn()} />)
    await screen.findByText('Conv 1')
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    fireEvent.click(screen.getByText('See all (10)'))
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    fireEvent.change(screen.getByLabelText('Search by title'), { target: { value: 'conv 10' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })
  it('open calls onOpen; closed calls onResume', async () => {
    data = ten()
    const onOpen = vi.fn(), onResume = vi.fn()
    render(<Conversations machine="m" root="/r" liveIds={new Set(['c2'])} onOpen={onOpen} onResume={onResume} />)
    fireEvent.click(await screen.findByText('Conv 1'))
    expect(onOpen).toHaveBeenCalledWith('c1')
    fireEvent.click(screen.getByText('Conv 2'))
    expect(onOpen).toHaveBeenCalledWith('c2')
    fireEvent.click(screen.getByText('Conv 3'))
    expect(onResume).toHaveBeenCalledWith('c3')
    expect(screen.getByText(/· 3 msgs/)).toBeTruthy()
  })
  it('with busy, closed ones are not resumed; open ones do open', async () => {
    data = ten()
    const onOpen = vi.fn(), onResume = vi.fn()
    render(<Conversations machine="m" root="/r" liveIds={new Set()} busy onOpen={onOpen} onResume={onResume} />)
    fireEvent.click(await screen.findByText('Conv 3'))
    expect(onResume).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Conv 1'))
    expect(onOpen).toHaveBeenCalledWith('c1')
  })
  it('empty list', async () => {
    data = []
    render(<Conversations machine="m" root="/r" liveIds={new Set()} onOpen={vi.fn()} onResume={vi.fn()} />)
    expect(await screen.findByText('No previous conversations on this machine')).toBeTruthy()
  })
  it('machine without caps (old quorumd): requests nothing and asks to update', () => {
    const f = vi.mocked(fetch)
    f.mockClear()
    render(<Conversations machine="m" root="/r" liveIds={new Set()} outdated onOpen={vi.fn()} onResume={vi.fn()} />)
    expect(screen.getByText('Update quorumd on this machine to see conversations')).toBeTruthy()
    expect(f).not.toHaveBeenCalled()
  })
})
