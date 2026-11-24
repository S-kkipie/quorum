import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'

const SAFE_URL = /^(https?:|mailto:)/i

function urlTransform(url: string): string {
  return SAFE_URL.test(url.trim()) ? url : ''
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const props = (node as { props?: { children?: ReactNode } }).props
  return textOf(props?.children)
}

function Pre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ''))
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }
  // Render the inner code as plain code so block code never gets the inline pill styling.
  const inner = Children.map(children, (c) =>
    isValidElement<{ className?: string; children?: ReactNode }>(c)
      ? <code className={c.props.className}>{c.props.children}</code>
      : c)
  return (
    <div className="relative my-2">
      <button type="button" onClick={copy} aria-label={copied ? 'Copied' : 'Copy'}
        className="absolute right-2 top-2 flex items-center gap-1 rounded-lg bg-chip px-1.5 py-0.5 text-xs text-muted-foreground hover:text-ink">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied && <span>Copied</span>}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-line bg-surface p-3 pr-16 text-xs text-ink">{inner}</pre>
    </div>
  )
}

const components: Components = {
  h1: (p) => <h1 className="mb-2 mt-3 text-lg font-semibold text-ink">{p.children}</h1>,
  h2: (p) => <h2 className="mb-2 mt-3 text-base font-semibold text-ink">{p.children}</h2>,
  h3: (p) => <h3 className="mb-1 mt-2 text-sm font-semibold text-ink">{p.children}</h3>,
  h4: (p) => <h4 className="mb-1 mt-2 text-sm font-medium text-ink">{p.children}</h4>,
  p: (p) => <p className="my-2">{p.children}</p>,
  ul: (p) => <ul className="my-2 list-disc pl-5">{p.children}</ul>,
  ol: (p) => <ol className="my-2 list-decimal pl-5">{p.children}</ol>,
  blockquote: (p) => <blockquote className="my-2 border-l-2 border-line pl-3 text-muted-foreground">{p.children}</blockquote>,
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:decoration-2">{children}</a>
    : <span>{children}</span>,
  img: ({ src, alt }) => {
    const label = `[image: ${alt ?? ''}]`
    const safe = typeof src === 'string' && /^https?:/i.test(src.trim())
    return safe
      ? <a href={src} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:decoration-2">{label}</a>
      : <span className="text-muted-foreground">{label}</span>
  },
  pre: (p) => <Pre>{p.children}</Pre>,
  code: ({ className, children }) => className
    ? <code className={className}>{children}</code>
    : <code className="rounded-md bg-chip px-1 py-0.5 text-[0.85em] text-ink">{children}</code>,
  table: (p) => <div className="my-2 overflow-x-auto"><table className="min-w-full border-collapse text-sm">{p.children}</table></div>,
  th: (p) => <th className="border border-line bg-chip px-2 py-1 text-left font-medium">{p.children}</th>,
  td: (p) => <td className="border border-line px-2 py-1">{p.children}</td>,
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="mx-auto max-w-[70ch] break-words font-serif text-[15.5px] leading-[1.6] text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>{text}</ReactMarkdown>
    </div>
  )
}
