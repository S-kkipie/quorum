import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { AlertCircle, Camera, Check, File as FileIcon, Image as ImageIcon, Loader2, Paperclip, X } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatSize, type Attachment } from '../lib/attachments'

/** A touch screen (phone, tablet): only there does "Take photo" open the camera. */
export function isTouch(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches } catch { return false }
}

/** The paperclip: a menu to take a photo (touch only), pick photos and videos, or any file. */
export function AttachMenu({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const camera = useRef<HTMLInputElement>(null)
  const media = useRef<HTMLInputElement>(null)
  const any = useRef<HTMLInputElement>(null)
  const touch = isTouch()
  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = '' // the same file can be picked again
    if (files.length) onFiles(files)
  }
  const item = 'min-h-11 gap-2.5 px-3'
  return (
    <>
      {touch && <input ref={camera} type="file" accept="image/*" capture="environment" hidden data-testid="attach-camera" onChange={picked} />}
      <input ref={media} type="file" accept="image/*,video/*" multiple hidden data-testid="attach-media" onChange={picked} />
      <input ref={any} type="file" multiple hidden data-testid="attach-file" onChange={picked} />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <PromptInputButton variant="ghost" size="sm" disabled={disabled} aria-label="Attach" title="Attach"
            className="size-11 shrink-0 rounded-lg px-0 text-muted-foreground hover:text-ink disabled:opacity-40">
            <Paperclip size={18} aria-hidden />
          </PromptInputButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          {touch && <DropdownMenuItem className={item} onSelect={() => camera.current?.click()}><Camera size={14} aria-hidden className="text-muted-foreground" />Take photo</DropdownMenuItem>}
          <DropdownMenuItem className={item} onSelect={() => media.current?.click()}><ImageIcon size={14} aria-hidden className="text-muted-foreground" />Photos &amp; videos</DropdownMenuItem>
          <DropdownMenuItem className={item} onSelect={() => any.current?.click()}><FileIcon size={14} aria-hidden className="text-muted-foreground" />File</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/** A local preview of an image file (an object URL, revoked when the chip goes away). */
function useObjectUrl(file: File): string {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return url
}

function Chip({ a, onRemove, disabled }: { a: Attachment; onRemove: (id: string) => void; disabled?: boolean }) {
  const thumb = useObjectUrl(a.file)
  const name = a.file.name || 'file'
  const state = a.state === 'uploading' ? 'Uploading' : a.state === 'done' ? 'Uploaded' : a.state === 'error' ? 'Upload failed' : ''
  return (
    <li className={`flex h-11 max-w-56 shrink-0 items-center gap-2 rounded-lg border bg-surface pl-1 ${a.state === 'error' ? 'border-danger' : 'border-line'}`}
      aria-label={[name, formatSize(a.file.size), state].filter(Boolean).join(', ')} title={a.error || name}>
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-chip text-muted-foreground">
        {thumb ? <img src={thumb} alt="" className="size-9 object-cover" /> : <FileIcon size={16} aria-hidden />}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-xs text-ink">{name}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {a.state === 'uploading' && <Loader2 size={11} aria-hidden className="animate-spin" />}
          {a.state === 'done' && <Check size={11} aria-hidden className="text-success" />}
          {a.state === 'error' && <AlertCircle size={11} aria-hidden className="text-danger" />}
          {formatSize(a.file.size)}
        </span>
      </span>
      <button type="button" aria-label={`Remove ${name}`} title="Remove" disabled={disabled} onClick={() => onRemove(a.id)}
        className="press flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-ink disabled:opacity-40">
        <X size={14} aria-hidden />
      </button>
    </li>
  )
}

/** The files attached to the draft, in a row that scrolls sideways. */
export function AttachmentChips({ items, onRemove, disabled }: { items: readonly Attachment[]; onRemove: (id: string) => void; disabled?: boolean }) {
  if (!items.length) return null
  return (
    <ScrollArea horizontal className="w-full" viewportClassName="pb-1">
      <ul aria-label="Attachments" className="flex w-max gap-2 px-2 pt-2">
        {items.map((a) => <Chip key={a.id} a={a} onRemove={onRemove} disabled={disabled} />)}
      </ul>
    </ScrollArea>
  )
}
