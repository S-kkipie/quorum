import { useState } from 'react'
import { defaultDeviceName, hubUrl, pair } from '../lib/api'

export default function Pair({ onPaired }: { onPaired: () => void }) {
  // Servido por el hub (mismo origen) la dirección puede quedar vacía.
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
      setErr(x instanceof TypeError ? 'no se pudo conectar con el hub' : (x as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-blue-500'
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Quorum</h1>
        <p className="text-sm text-zinc-400">Empareja este dispositivo con tu hub. Genera un código en el hub con <code className="text-zinc-300">quorum-hub pair</code>.</p>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-400">Dirección del hub</span>
          <input className={input} value={hub} onChange={(e) => setHub(e.target.value)} placeholder="http://mi-hub:7420" autoCapitalize="none" autoCorrect="off" />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-400">Código</span>
          <input className={input + ' font-mono tracking-widest'} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-400">Nombre del dispositivo</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
        <button disabled={busy || !code.trim()} className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50">
          {busy ? 'Emparejando…' : 'Emparejar'}
        </button>
      </form>
    </main>
  )
}
