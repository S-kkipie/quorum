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
        className="absolute right-2 top-2 flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied && <span>Copied</span>}
      </button>
      <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 pr-16 text-xs text-zinc-200">{inner}</pre>
    </div>
  )
}

const components: Components = {
  h1: (p) => <h1 className="mb-2 mt-3 text-lg font-semibold text-zinc-100">{p.children}</h1>,
  h2: (p) => <h2 className="mb-2 mt-3 text-base font-semibold text-zinc-100">{p.children}</h2>,
  h3: (p) => <h3 className="mb-1 mt-2 text-sm font-semibold text-zinc-100">{p.children}</h3>,
  h4: (p) => <h4 className="mb-1 mt-2 text-sm font-medium text-zinc-200">{p.children}</h4>,
  p: (p) => <p className="my-2 leading-relaxed">{p.children}</p>,
  ul: (p) => <ul className="my-2 list-disc pl-5">{p.children}</ul>,
  ol: (p) => <ol className="my-2 list-decimal pl-5">{p.children}</ol>,
  blockquote: (p) => <blockquote className="my-2 border-l-2 border-zinc-700 pl-3 text-zinc-400">{p.children}</blockquote>,
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300">{children}</a>
    : <span>{children}</span>,
  img: ({ src, alt }) => {
    const label = `[image: ${alt ?? ''}]`
    const safe = typeof src === 'string' && /^https?:/i.test(src.trim())
    return safe
      ? <a href={src} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300">{label}</a>
      : <span className="text-zinc-400">{label}</span>
  },
  pre: (p) => <Pre>{p.children}</Pre>,
  code: ({ className, children }) => className
    ? <code className={className}>{children}</code>
    : <code className="rounded bg-zinc-800 px-1 py-0.5 text-[0.85em] text-zinc-200">{children}</code>,
  table: (p) => <div className="my-2 overflow-x-auto"><table className="min-w-full border-collapse text-sm">{p.children}</table></div>,
  th: (p) => <th className="border border-zinc-700 bg-zinc-900 px-2 py-1 text-left font-medium">{p.children}</th>,
  td: (p) => <td className="border border-zinc-800 px-2 py-1">{p.children}</td>,
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm text-zinc-200 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>{text}</ReactMarkdown>
    </div>
  )
}
