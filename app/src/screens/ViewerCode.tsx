import type { BundledLanguage } from 'shiki'
import { CodeBlock } from '@/components/ai-elements/code-block'

export const MAX_LINES = 2000

const LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  go: 'go', py: 'python', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', c: 'c', h: 'c',
  cpp: 'cpp', cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yaml: 'yaml',
  yml: 'yaml', toml: 'toml', css: 'css', sql: 'sql', xml: 'xml', diff: 'diff', mdx: 'mdx',
  proto: 'proto', php: 'php', swift: 'swift', lua: 'lua', vue: 'vue',
}

/** Highlighted view of a text file (lazy chunk: keeps shiki out of the entry bundle). */
/** cutBytes: the file was longer than what was read (see CODE_MAX_BYTES in Viewer). */
export default function ViewerCode({ text, name, cutBytes = false }: { text: string; name: string; cutBytes?: boolean }) {
  const lines = text.split('\n')
  const cut = lines.length > MAX_LINES
  const code = cut ? lines.slice(0, MAX_LINES).join('\n') : text
  const lang = (LANGS[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'text') as BundledLanguage
  return (
    <div className="p-2">
      {cut ? <p className="px-1 pb-2 text-xs text-muted-foreground">Showing the first 2,000 lines.</p>
        : cutBytes && <p className="px-1 pb-2 text-xs text-muted-foreground">Showing the first 1 MB.</p>}
      <CodeBlock code={code} language={lang} showLineNumbers className="text-xs" />
    </div>
  )
}
