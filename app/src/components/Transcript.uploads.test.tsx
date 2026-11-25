// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const createView = vi.fn()
vi.mock('../lib/api', () => ({ createView: (...a: any[]) => createView(...a), hubUrl: () => '' }))
import Transcript from './Transcript'
import { resetPastedImageLinks } from './timeline/PastedImages'
import type { Event } from '../proto.gen'

const DIR = '/home/u/.cache/quorum/uploads/2026-11-25'
const ev = (seq: number, kind: string, data: any): Event => ({ seq, session: 's1', ts: 0, kind, data })
afterEach(() => { cleanup(); createView.mockReset(); resetPastedImageLinks() })

describe('Transcript attachments', () => {
  it('a user bubble shows uploads as a thumbnail and a file chip instead of the raw mentions', async () => {
    createView.mockImplementation(async (_m: string, _s: string, p: string) => ({ url: `/v/aa01/${p.split('/').pop()}` }))
    const onOpenFile = vi.fn()
    render(<Transcript machine="vps-1" sessionId="s1" onOpenFile={onOpenFile}
      events={[ev(1, 'user', { text: `@${DIR}/a1b2c3-photo.jpg\n@${DIR}/d4e5f6-report.pdf\nwhat is this?` })]} />)
    const bubble = screen.getByRole('article', { name: 'You' })
    expect(bubble.textContent).toContain('what is this?')
    expect(bubble.textContent).not.toContain('@/')
    const img = await screen.findByRole('img', { name: 'photo.jpg' })
    expect(img.getAttribute('src')).toBe('/v/aa01/a1b2c3-photo.jpg')
    expect(createView).toHaveBeenCalledWith('vps-1', 's1', `${DIR}/a1b2c3-photo.jpg`, 'upload')
    fireEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }))
    expect(onOpenFile).toHaveBeenCalledWith(`${DIR}/d4e5f6-report.pdf`, { upload: true })
    expect(createView).toHaveBeenCalledTimes(1) // a file chip asks for no link until opened
  })
  it('a command bubble keeps the command and shows its attachments', () => {
    render(<Transcript machine="vps-1" sessionId="s1"
      events={[ev(1, 'user', { text: '', command: { name: 'review', args: `the diff @${DIR}/d4e5f6-report.pdf` } })]} />)
    expect(screen.getByTestId('command-prompt').textContent).toContain('/review the diff')
    expect(screen.getByTestId('command-prompt').textContent).not.toContain('@/')
    expect(screen.getByRole('button', { name: 'Open report.pdf' })).toBeTruthy()
  })
  it('a key file chip says why it does not open', () => {
    render(<Transcript machine="vps-1" sessionId="s1" onOpenFile={vi.fn()} events={[ev(1, 'user', { text: `@${DIR}/a1b2c3-server.pem` })]} />)
    expect(screen.queryByRole('button', { name: 'Open server.pem' })).toBeNull()
    expect(screen.getByText('Key files are not shown')).toBeTruthy()
    expect(createView).not.toHaveBeenCalled()
  })
  it('a plain mention that is not an upload stays text', () => {
    render(<Transcript machine="vps-1" sessionId="s1" events={[ev(1, 'user', { text: 'see @src/app.ts' })]} />)
    expect(screen.getByRole('article', { name: 'You' }).textContent).toBe('see @src/app.ts')
  })
})
