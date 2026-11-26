import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { updateProject } from '../lib/api'

export const GLOSSARY_MAX = 2000

/** The project's glossary: names and terms the transcription and the correction pass should spell right. */
export default function GlossaryDialog({ projectId, initial, onClose }: { projectId: string; initial: string; onClose: () => void }) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const n = [...text].length
  const over = n > GLOSSARY_MAX
  async function save() {
    setBusy(true)
    setError('')
    try { await updateProject(projectId, { glossary: text }); onClose() } catch (e) { setError(e instanceof Error ? e.message : 'error'); setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Glossary</DialogTitle>
          <DialogDescription>Names, products and terms of this project, one per line or comma-separated. Meetings spell them as written here. Transcription only uses roughly the first 600 characters; put the most important terms first.</DialogDescription>
        </DialogHeader>
        <textarea aria-label="Glossary terms" value={text} onChange={(e) => setText(e.target.value)} rows={8}
          className="min-h-11 w-full rounded-lg border border-line bg-surface p-2 text-sm" />
        <p className={`text-xs ${over ? 'text-danger' : 'text-muted-foreground'}`} aria-live="polite">{n} / {GLOSSARY_MAX}</p>
        {error && <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} className="min-h-11">Cancel</Button>
          <Button type="button" disabled={busy || over} onClick={() => void save()} className="min-h-11">Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
