// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({ uploadMeeting: vi.fn() }))
vi.mock('../../lib/meetingsApi', async (orig) => ({ ...(await orig<typeof import('../../lib/meetingsApi')>()), uploadMeeting: api.uploadMeeting }))
import UploadMeeting from './UploadMeeting'
import { ApiError } from '../../lib/api'

const mem: Record<string, string> = {}
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v }, removeItem: (k: string) => { delete mem[k] } })
})
afterEach(() => { api.uploadMeeting.mockReset(); for (const k in mem) delete mem[k] })

const pick = (f: File) => fireEvent.change(screen.getByLabelText('Recording file'), { target: { files: [f] } })
const file = (size = 10, name = 'call.ogg') => {
  const f = new File(['x'], name, { type: 'audio/ogg', lastModified: 7 })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('UploadMeeting', () => {
  it('shows the progress per chunk and reports the uploaded meeting', async () => {
    let finish!: (m: unknown) => void
    api.uploadMeeting.mockImplementation((_f, opts, onProgress) => {
      opts.onUploadId?.('up1')
      onProgress(0, 10)
      onProgress(4, 10)
      return new Promise((r) => { finish = r })
    })
    const onUploaded = vi.fn()
    render(<UploadMeeting projectId="p1" onUploaded={onUploaded} />)
    pick(file())
    await waitFor(() => expect(screen.getByText(/40%/)).toBeTruthy())
    expect(screen.getByRole('progressbar')).toBeTruthy()
    expect(api.uploadMeeting.mock.calls[0][1]).toMatchObject({ projectId: 'p1' })
    await act(async () => finish({ id: 'm1', status: 'queued' }))
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }))
    expect(screen.queryByRole('progressbar')).toBeNull()
    // a finished upload is forgotten
    expect(Object.keys(mem).filter((k) => k.startsWith('quorum.meetingUpload'))).toEqual([])
  })

  it('a failed upload offers Resume, which continues the same upload id', async () => {
    api.uploadMeeting.mockImplementationOnce(async (_f, opts, onProgress) => {
      opts.onUploadId?.('up1')
      onProgress(4, 10)
      throw new ApiError('Failed to fetch', 0, null)
    })
    render(<UploadMeeting projectId="p1" />)
    const f = file()
    pick(f)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('Failed to fetch')
    api.uploadMeeting.mockImplementationOnce(async (_f, _opts, onProgress) => { onProgress(10, 10); return { id: 'm1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(api.uploadMeeting).toHaveBeenCalledTimes(2))
    expect(api.uploadMeeting.mock.calls[1][0]).toBe(f)
    expect(api.uploadMeeting.mock.calls[1][1]).toMatchObject({ uploadId: 'up1', projectId: 'p1' })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('the same file picked again after a reload resumes the saved upload', async () => {
    mem['quorum.meetingUpload:p1:call.ogg:10:7'] = 'up9'
    api.uploadMeeting.mockResolvedValue({ id: 'm1' })
    render(<UploadMeeting projectId="p1" />)
    pick(file())
    await waitFor(() => expect(api.uploadMeeting).toHaveBeenCalled())
    expect(api.uploadMeeting.mock.calls[0][1]).toMatchObject({ uploadId: 'up9' })
  })

  it('a saved upload the hub no longer knows starts over', async () => {
    mem['quorum.meetingUpload:p1:call.ogg:10:7'] = 'gone'
    api.uploadMeeting.mockRejectedValueOnce(new ApiError('no such upload', 404, null)).mockResolvedValueOnce({ id: 'm1' })
    const onUploaded = vi.fn()
    render(<UploadMeeting projectId="p1" onUploaded={onUploaded} />)
    pick(file())
    await waitFor(() => expect(onUploaded).toHaveBeenCalled())
    expect(api.uploadMeeting.mock.calls[0][1].uploadId).toBe('gone')
    expect(api.uploadMeeting.mock.calls[1][1].uploadId).toBeUndefined()
  })

  it('refuses a file over 400 MB before sending anything', async () => {
    render(<UploadMeeting projectId="p1" />)
    pick(file(400 * 1024 * 1024 + 1))
    expect((await screen.findByRole('alert')).textContent).toMatch(/larger than 400 MB/)
    expect(api.uploadMeeting).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  it('the button is a 44 px target', () => {
    render(<UploadMeeting projectId="p1" />)
    expect(screen.getByRole('button', { name: 'Upload recording' }).className).toContain('min-h-11')
  })
})
