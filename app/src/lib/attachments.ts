/**
 * Files attached to a chat message. Each one is uploaded once to the session's machine (the hub
 * relays it), then the message mentions it as `@<absolute path>`: one mention per line before the
 * text, or appended after a slash command with spaces. The machine saves every file as
 * `<user cache dir>/quorum/uploads/<yyyy-mm-dd>/<6 hex>-<sanitized name>` and refuses a cache
 * folder whose path has a space, so the paths never hold one.
 */

export const MAX_FILES = 10
export const MAX_FILE_BYTES = 100 * 1024 * 1024

export type AttachState = 'ready' | 'uploading' | 'done' | 'error'
export interface Attachment {
  id: string
  file: File
  state: AttachState
  /** where the machine saved it (state 'done') */
  path?: string
  error?: string
}

let seq = 0
const newId = () => `a${++seq}`

/** Human size: 980 B, 12 KB, 3.4 MB. */
export function formatSize(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1000 * 1000) return `${Math.round(n / 1000)} KB`
  const mb = n / (1000 * 1000)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/**
 * Adds files to the list: at most MAX_FILES in all and MAX_FILE_BYTES each. What does not fit is
 * left out and named in the error ('' when everything was added).
 */
export function addFiles(list: readonly Attachment[], files: readonly File[]): { list: Attachment[]; error: string } {
  const out = [...list]
  const big: string[] = []
  let over = 0
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) { big.push(f.name || 'file'); continue }
    if (out.length >= MAX_FILES) { over++; continue }
    out.push({ id: newId(), file: f, state: 'ready' })
  }
  const errs: string[] = []
  if (big.length) errs.push(`${big.join(', ')} ${big.length === 1 ? 'is' : 'are'} over 100 MB`)
  if (over) errs.push(`At most ${MAX_FILES} files per message`)
  return { list: out, error: errs.join('. ') }
}

/** The text sent for a message with these saved paths (exactly as pastor did). */
export function buildMessage(text: string, paths: readonly string[]): string {
  if (!paths.length) return text
  const mentions = paths.map((p) => '@' + p)
  if (text.startsWith('/')) return [text, ...mentions].join(' ')
  return text ? [...mentions, text].join('\n') : mentions.join('\n')
}

// an upload's absolute path, Unix or Windows, in the machine's user cache folder (Linux
// ~/.cache, Windows %LocalAppData%, macOS ~/Library/Caches): …/quorum/uploads/<yyyy-mm-dd>/<6 hex>-<name>
const UPLOAD_SRC = String.raw`(?:[A-Za-z]:)?[\\/](?:[^\s\\/]+[\\/])*quorum[\\/]uploads[\\/]\d{4}-\d{2}-\d{2}[\\/][0-9a-f]{6}-[A-Za-z0-9_.-]+`
const MENTION = new RegExp(String.raw`(^|\s)@(` + UPLOAD_SRC + String.raw`)(?=\s|$)`, 'g')

export interface UploadRef { path: string; name: string; image: boolean }

/**
 * Key and certificate files the hub never serves (what viewguard.Sensitive refuses of an upload's
 * name: a sanitized name never starts with a dot, and the 6-hex prefix hides an id_rsa start).
 */
export const keyFile = (name: string): boolean => /\.(pem|key|p12|pfx)$/i.test(name)

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

/** The name shown for a saved upload: its file name without the 6-hex prefix. */
export const uploadName = (path: string): string => (path.split(/[\\/]/).pop() ?? path).replace(/^[0-9a-f]{6}-/, '')

/**
 * Splits the upload mentions out of a sent message: the files (in order, without duplicates) and
 * the text left, with the blank lines the mentions leave at its edges removed.
 */
export function splitUploads(text: string): { text: string; files: UploadRef[] } {
  if (!text.includes('uploads')) return { text, files: [] }
  const files: UploadRef[] = []
  const seen = new Set<string>()
  const rest = text.replace(MENTION, (_m, pre: string, path: string) => {
    if (!seen.has(path)) {
      seen.add(path)
      files.push({ path, name: uploadName(path), image: IMAGE.test(path) })
    }
    return pre === '\n' ? '\n' : ''
  })
  if (!files.length) return { text, files }
  return { text: rest.replace(/^\s*\n/, '').replace(/[ \t]+$/gm, '').trim(), files }
}
