// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ModelEffortSheet from './ModelEffortSheet'

afterEach(cleanup)

const OPTS = [
  { value: 'default', label: 'Default', description: '' },
  { value: 'opus', label: 'Opus', description: '' },
  { value: 'sonnet', label: 'Sonnet', description: '' },
]

describe('ModelEffortSheet: model radios', () => {
  it('roving tabindex: only the checked radio is in the tab order', async () => {
    render(<ModelEffortSheet open onOpenChange={vi.fn()} options={OPTS} current="opus" effort="" efforts={[]} onPick={vi.fn()} />)
    const radios = await screen.findAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })
  it('no current model: the first radio takes the tab stop', async () => {
    render(<ModelEffortSheet open onOpenChange={vi.fn()} options={OPTS} effort="" efforts={[]} onPick={vi.fn()} />)
    const radios = await screen.findAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
  })
  it('arrow keys move the focus (wrapping), Home/End jump; only a pick (click, Enter, Space) switches', async () => {
    const onPick = vi.fn()
    render(<ModelEffortSheet open onOpenChange={vi.fn()} options={OPTS} current="opus" effort="" efforts={[]} onPick={onPick} />)
    const radios = await screen.findAllByRole('radio')
    radios[1].focus()
    fireEvent.keyDown(radios[1], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(radios[2])
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])
    fireEvent.keyDown(radios[2], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radios[0])
    fireEvent.keyDown(radios[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(radios[2])
    fireEvent.keyDown(radios[2], { key: 'Home' })
    expect(document.activeElement).toBe(radios[0])
    fireEvent.keyDown(radios[0], { key: 'End' })
    expect(document.activeElement).toBe(radios[2])
    // moving the focus does not switch the model (a switch is a deliberate pick)
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.click(radios[2])
    expect(onPick).toHaveBeenCalledWith('sonnet')
  })
})
