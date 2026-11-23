// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ProjectCard from './ProjectCard'
import { proj, sess } from '../lib/fixtures.test-util'

afterEach(cleanup)

describe('ProjectCard', () => {
  it('muestra avance, resumen, error de sincronización, propuestas y sesiones vivas', () => {
    const onOpen = vi.fn()
    const onOpenSession = vi.fn()
    render(<ProjectCard project={proj('p1', { summary: 'Va bien; lo frena el login', syncError: 'token inválido (HTTP 401)', progress: { done: 3, total: 8 } })}
      sessions={[sess('s1', { recap: 'Arreglando el login', state: 'needs_you' })]} pending={2} onOpen={onOpen} onOpenSession={onOpenSession} />)
    expect(screen.getByText('3/8')).toBeTruthy()
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('3')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('8')
    expect(screen.getByText('Va bien; lo frena el login')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Error de sincronización: token inválido (HTTP 401)')
    expect(screen.getByText('2 propuestas')).toBeTruthy()
    expect(screen.getByText('te necesita')).toBeTruthy()
    fireEvent.click(screen.getByText('Arreglando el login'))
    expect(onOpenSession).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByText('Proyecto p1'))
    expect(onOpen).toHaveBeenCalledWith('p1')
  })
  it('sin error no muestra alerta', () => {
    render(<ProjectCard project={proj('p1')} sessions={[]} pending={0} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/propuesta/)).toBeNull()
  })
})
