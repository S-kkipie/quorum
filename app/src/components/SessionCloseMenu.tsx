import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { closeSession } from '../lib/api'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

/** The "⋯" menu of a session row: "Close session", confirmed in a dialog. A failure goes to `onError` ('' when it starts over). */
export default function SessionCloseMenu({ id, className = '', onError }: { id: string; className?: string; onError?: (message: string) => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  async function close() {
    setBusy(true)
    onError?.('')
    try {
      await closeSession(id)
      setConfirm(false)
    } catch (e) {
      setConfirm(false)
      onError?.(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Session actions" className={`size-11 shrink-0 text-muted-foreground ${className}`}><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="min-h-11" onSelect={() => setConfirm(true)}>Close session</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Close session</DialogTitle>
            <DialogDescription>Close this session? Claude stops in its terminal.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button className="min-h-11" disabled={busy} onClick={close}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
