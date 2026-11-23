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
  it('muestra 6 de 10 y "Ver todas (10)" expande con buscador', async () => {
    data = ten()
    render(<Conversations machine="m" root="/r" liveIds={new Set()} onOpen={vi.fn()} onResume={vi.fn()} />)
    await screen.findByText('Conv 1')
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    fireEvent.click(screen.getByText('Ver todas (10)'))
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    fireEvent.change(screen.getByLabelText('Buscar por título'), { target: { value: 'conv 10' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })
  it('abierta llama onOpen; cerrada llama onResume', async () => {
    data = ten()
    const onOpen = vi.fn(), onResume = vi.fn()
    render(<Conversations machine="m" root="/r" liveIds={new Set(['c2'])} onOpen={onOpen} onResume={onResume} />)
    fireEvent.click(await screen.findByText('Conv 1'))
    expect(onOpen).toHaveBeenCalledWith('c1')
    fireEvent.click(screen.getByText('Conv 2'))
    expect(onOpen).toHaveBeenCalledWith('c2')
    fireEvent.click(screen.getByText('Conv 3'))
    expect(onResume).toHaveBeenCalledWith('c3')
    expect(screen.getByText(/· 3 msj/)).toBeTruthy()
  })
  it('con busy las cerradas no se retoman; las abiertas sí abren', async () => {
    data = ten()
    const onOpen = vi.fn(), onResume = vi.fn()
    render(<Conversations machine="m" root="/r" liveIds={new Set()} busy onOpen={onOpen} onResume={onResume} />)
    fireEvent.click(await screen.findByText('Conv 3'))
    expect(onResume).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Conv 1'))
    expect(onOpen).toHaveBeenCalledWith('c1')
  })
  it('lista vacía', async () => {
    data = []
    render(<Conversations machine="m" root="/r" liveIds={new Set()} onOpen={vi.fn()} onResume={vi.fn()} />)
    expect(await screen.findByText('Sin conversaciones anteriores en esta máquina')).toBeTruthy()
  })
  it('máquina sin caps (quorumd viejo): no pide nada y pide actualizar', () => {
    const f = vi.mocked(fetch)
    f.mockClear()
    render(<Conversations machine="m" root="/r" liveIds={new Set()} outdated onOpen={vi.fn()} onResume={vi.fn()} />)
    expect(screen.getByText('Actualiza quorumd en esta máquina para ver conversaciones')).toBeTruthy()
    expect(f).not.toHaveBeenCalled()
  })
})
