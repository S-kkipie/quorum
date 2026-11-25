import { describe, expect, it } from 'vitest'
import { addFiles, buildMessage, formatSize, MAX_FILE_BYTES, splitUploads, uploadName } from './attachments'

const file = (name: string, size = 3, type = 'image/png') => {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const P1 = '/home/u/.config/quorum/uploads/2026-11-25/a1b2c3-photo.jpg'
const P2 = '/home/u/.config/quorum/uploads/2026-11-25/d4e5f6-report.pdf'
const W1 = 'C:\\Users\\u\\.config\\quorum\\uploads\\2026-11-25\\0a0b0c-clip.mp4'

describe('attachments', () => {
  it('adds up to 10 files and rejects the rest', () => {
    const r = addFiles([], Array.from({ length: 12 }, (_, i) => file(`f${i}.png`)))
    expect(r.list).toHaveLength(10)
    expect(r.error).toBe('At most 10 files per message')
    const more = addFiles(r.list, [file('x.png')])
    expect(more.list).toHaveLength(10)
    expect(more.error).toBe('At most 10 files per message')
  })
  it('rejects a file over 100 MB, naming it, and keeps the others', () => {
    const r = addFiles([], [file('ok.png'), file('huge.mov', MAX_FILE_BYTES + 1, 'video/quicktime'), file('max.bin', MAX_FILE_BYTES)])
    expect(r.list.map((a) => a.file.name)).toEqual(['ok.png', 'max.bin'])
    expect(r.list.every((a) => a.state === 'ready')).toBe(true)
    expect(r.error).toBe('huge.mov is over 100 MB')
  })
  it('builds the text exactly as pastor did', () => {
    expect(buildMessage('look at these', [P1, P2])).toBe(`@${P1}\n@${P2}\nlook at these`)
    expect(buildMessage('', [P1])).toBe(`@${P1}`)
    expect(buildMessage('/review the diff', [P1, P2])).toBe(`/review the diff @${P1} @${P2}`)
    expect(buildMessage('just text', [])).toBe('just text')
  })
  it('splits the upload mentions out of a sent message', () => {
    expect(splitUploads(`@${P1}\n@${P2}\nlook at these`)).toEqual({
      text: 'look at these',
      files: [{ path: P1, name: 'photo.jpg', image: true }, { path: P2, name: 'report.pdf', image: false }],
    })
    expect(splitUploads(`/review the diff @${P1} @${P2}`).text).toBe('/review the diff')
    expect(splitUploads(`@${W1}\nhi`)).toEqual({ text: 'hi', files: [{ path: W1, name: 'clip.mp4', image: false }] })
    expect(splitUploads(`@${P1}`).text).toBe('')
  })
  it('leaves other mentions and look-alikes alone', () => {
    for (const t of ['@src/app.ts please', 'see /x/uploads/2026-11-25/a1b2c3-x.png', `email@${P1}`, '@/x/uploads/26-11-25/a1b2c3-x.png']) {
      expect(splitUploads(t)).toEqual({ text: t, files: [] })
    }
  })
  it('names and sizes', () => {
    expect(uploadName(P1)).toBe('photo.jpg')
    expect(formatSize(980)).toBe('980 B')
    expect(formatSize(12_300)).toBe('12 KB')
    expect(formatSize(3_400_000)).toBe('3.4 MB')
    expect(formatSize(55_000_000)).toBe('55 MB')
  })
})
