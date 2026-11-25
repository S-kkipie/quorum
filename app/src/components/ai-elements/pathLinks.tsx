import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from "react";
import { findPaths } from "@/lib/paths";
import { baseOf } from "@/lib/timeline";

type Ctx = { base: string; worktrees?: readonly string[]; onOpen: (path: string) => void };
const PathLinksContext = createContext<Ctx | null>(null);

/** Makes file paths inside `MessageResponse` text tappable; `onOpen` gets the absolute path. */
export function PathLinksProvider({ base, worktrees, onOpen, children }: Ctx & { children: ReactNode }) {
  const value = useMemo(() => ({ base, worktrees, onOpen }), [base, worktrees, onOpen]);
  return <PathLinksContext.Provider value={value}>{children}</PathLinksContext.Provider>;
}

export const usePathLinks = () => useContext(PathLinksContext);

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const SKIP = new Set(["pre", "a", "script", "style"]);

type Bases = { base: string; worktrees?: readonly string[] };

function splitText(node: HastNode, b: Bases): HastNode[] | null {
  const text = node.value ?? "";
  const found = findPaths(text, b.base, b.worktrees);
  if (found.length === 0) return null;
  const out: HastNode[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start > at) out.push({ type: "text", value: text.slice(at, f.start) });
    out.push({
      type: "element",
      tagName: "span",
      properties: { dataQuorumPath: f.path },
      children: [{ type: "text", value: text.slice(f.start, f.end) }],
    });
    at = f.end;
  }
  if (at < text.length) out.push({ type: "text", value: text.slice(at) });
  return out;
}

function walk(node: HastNode, base: Bases) {
  if (!node.children || (node.tagName && SKIP.has(node.tagName))) return;
  const next: HastNode[] = [];
  for (const c of node.children) {
    const parts = c.type === "text" ? splitText(c, base) : null;
    if (parts) next.push(...parts);
    else {
      walk(c, base);
      next.push(c);
    }
  }
  node.children = next;
}

/** Rehype plugin: wraps path-like text (also in inline code, never in fenced blocks or links) in marked spans. */
export const rehypePathLinks = (opts: Bases) => (tree: HastNode) => walk(tree, opts);

/** `span` override: marked spans become inline link-style buttons, everything else stays a span. */
export function PathSpan(props: ComponentProps<"span"> & { node?: unknown; "data-quorum-path"?: string }) {
  const { node: _node, "data-quorum-path": path, children, ...rest } = props;
  const ctx = usePathLinks();
  if (!path || !ctx) return <span {...rest}>{children}</span>;
  const b = baseOf(path, ctx.base, ctx.worktrees);
  const rel = path.startsWith(b) ? path.slice(b.length).replace(/^[\\/]+/, "") : path;
  return (
    <button
      type="button"
      aria-label={`Open ${rel}`}
      onClick={() => ctx.onOpen(path)}
      className="inline cursor-pointer break-all border-0 bg-transparent p-0 text-left align-baseline font-medium text-accent underline decoration-accent/50 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </button>
  );
}
