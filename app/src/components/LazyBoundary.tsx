import { Component, Suspense, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

/** Catches a failed lazy chunk (e.g. an old tab after a deploy) instead of unmounting the whole app. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(e: unknown) { console.error('lazy view failed', e) }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-zinc-400">
        <p>This view could not load.</p>
        <Button variant="secondary" className="min-h-11" onClick={() => location.reload()}>Reload</Button>
      </div>
    )
  }
}

/** Suspense + error boundary for every React.lazy view. */
export default function LazyBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary>
      <Suspense fallback={<div className="flex h-full items-center justify-center text-zinc-500"><Spinner /></div>}>{children}</Suspense>
    </Boundary>
  )
}
