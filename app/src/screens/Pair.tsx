import { useState } from 'react'
import { defaultDeviceName, hubUrl, pair } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function Pair({ onPaired }: { onPaired: () => void }) {
  // When served by the hub (same origin) the address can stay empty.
  const [hub, setHub] = useState(hubUrl() || (location.protocol.startsWith('http') && !import.meta.env.DEV ? location.origin : ''))
  const [code, setCode] = useState('')
  const [name, setName] = useState(defaultDeviceName())
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      await pair(hub, code, name)
      onPaired()
    } catch (x) {
      setErr(x instanceof TypeError ? 'could not connect to the hub' : (x as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const input = 'min-h-11 border-line bg-surface px-3 py-2 text-sm'
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Quorum</h1>
        <p className="text-sm text-muted-foreground">Pair this device with your hub. Generate a code on the hub with <code className="text-ink">quorum-hub pair</code>.</p>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Hub address</span>
          <Input className={input} value={hub} onChange={(e) => setHub(e.target.value)} placeholder="http://my-hub:7420" autoCapitalize="none" autoCorrect="off" />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Code</span>
          <Input className={input + ' font-mono tracking-widest'} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Device name</span>
          <Input className={input} value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <Button type="submit" disabled={busy || !code.trim()} className="min-h-11 w-full">
          {busy ? 'Pairing…' : 'Pair'}
        </Button>
      </form>
    </main>
  )
}
