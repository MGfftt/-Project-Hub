/**
 * SearchBox — debounced project search with a keyboard-driven results dropdown.
 *
 * The input carries `id="hub-search"` because `AppShell` focuses it on
 * Ctrl/Cmd + F.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Folder, FolderTree, Tag } from 'lucide-react'
import type { NodeKind, SearchHit, TreeNode } from '@shared/types'
import { useTree } from '@renderer/stores/tree'
import { useUi } from '@renderer/stores/ui'

const DEBOUNCE_MS = 250
const MAX_RESULTS = 30
const SNIPPET_MAX = 120

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Middle-truncation for long paths / names. */
function truncateMiddle(value: string, max = 52): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MATCH_LABEL: Record<string, string> = {
  display_name: '显示名',
  name: '名称',
  path: '路径',
  tag: '标签',
  note: '备注'
}

const KIND_LABEL: Record<NodeKind, string> = { group: '分组', project: '项目', folder: '文件夹' }

function labelOf(hit: SearchHit): string {
  return hit.displayName || hit.name
}

/** `byId` is a `Map` by contract; tolerate a plain record just in case. */
function lookupNode(byId: unknown, id: number): TreeNode | undefined {
  if (!byId) return undefined
  if (byId instanceof Map) return (byId as Map<number, TreeNode>).get(id)
  if (typeof byId === 'object') return (byId as Record<number, TreeNode>)[id]
  return undefined
}

function KIND_ICON({ kind }: { kind: NodeKind }) {
  const cls = 'h-4 w-4 shrink-0 text-[var(--text-dim)]'
  if (kind === 'group') return <FolderTree className={cls} aria-hidden />
  if (kind === 'folder') return <Folder className={cls} aria-hidden />
  return <FileText className={cls} aria-hidden />
}

interface SnippetProps {
  text: string
  query: string
}

/** Highlights the matched substring; the query is escaped first. */
function Snippet({ text, query }: SnippetProps) {
  const q = query.trim()
  const clipped = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text
  if (!q) return <span>{clipped}</span>

  const re = new RegExp(escapeRegExp(q), 'gi')
  const parts: Array<{ text: string; hit: boolean }> = []
  let cursor = 0
  for (let m = re.exec(clipped); m !== null; m = re.exec(clipped)) {
    if (m.index > cursor) parts.push({ text: clipped.slice(cursor, m.index), hit: false })
    parts.push({ text: m[0], hit: true })
    cursor = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex += 1
  }
  if (cursor < clipped.length) parts.push({ text: clipped.slice(cursor), hit: false })

  return (
    <span>
      {parts.map((p, i) =>
        p.hit ? (
          <mark
            key={`${i}-${p.text}`}
            className="rounded-[2px] bg-[var(--accent)]/25 px-0.5 text-[var(--text)]"
          >
            {p.text}
          </mark>
        ) : (
          <span key={`${i}-${p.text}`}>{p.text}</span>
        )
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* SearchBox                                                           */
/* ------------------------------------------------------------------ */

export default function SearchBox() {
  const select = useUi((s) => s.select)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** Monotonic token: stale IPC replies are dropped. */
  const seqRef = useRef(0)

  /* --- debounced query --------------------------------------------- */
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      seqRef.current += 1
      setHits([])
      setLoading(false)
      setOpen(false)
      setActive(0)
      return
    }

    setLoading(true)
    const seq = seqRef.current + 1
    seqRef.current = seq
    const timer = window.setTimeout(() => {
      void window.hub.search
        .query(q)
        .then((found) => {
          if (seqRef.current !== seq) return
          setHits(found)
          setActive(0)
          setOpen(true)
        })
        .catch(() => {
          if (seqRef.current !== seq) return
          setHits([])
          setOpen(true)
        })
        .finally(() => {
          if (seqRef.current === seq) setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [query])

  /* --- close on outside click -------------------------------------- */
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const visible = useMemo(() => hits.slice(0, MAX_RESULTS), [hits])
  const hiddenCount = hits.length - visible.length

  /* --- choosing a result ------------------------------------------- */
  const choose = useCallback(
    (hit: SearchHit) => {
      select(hit.nodeId)

      // Expand every ancestor so the selected row is actually visible.
      const byId = useTree.getState().byId
      const ancestors: number[] = []
      const seen = new Set<number>([hit.nodeId])
      let parentId = lookupNode(byId, hit.nodeId)?.parent_id ?? null
      while (parentId !== null && !seen.has(parentId)) {
        seen.add(parentId)
        ancestors.push(parentId)
        parentId = lookupNode(byId, parentId)?.parent_id ?? null
      }

      const setOpenNode = useTree.getState().setOpen
      for (const id of ancestors) setOpenNode(id, true)

      setOpen(false)
      setQuery('')
      setHits([])
      setActive(0)
      inputRef.current?.blur()
    },
    [select]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (!open && visible.length > 0) setOpen(true)
        setActive((i) => (visible.length === 0 ? 0 : (i + 1) % visible.length))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (!open && visible.length > 0) setOpen(true)
        setActive((i) => (visible.length === 0 ? 0 : (i - 1 + visible.length) % visible.length))
        return
      }
      if (e.key === 'Enter') {
        const hit = visible[active]
        if (hit) {
          e.preventDefault()
          choose(hit)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (query) {
          // First Escape empties the box; a second one closes the dropdown.
          setQuery('')
          setHits([])
          setOpen(false)
        } else {
          setOpen(false)
          inputRef.current?.blur()
        }
      }
    },
    [open, visible, active, choose, query]
  )

  const showDropdown = open && query.trim().length > 0

  return (
    <div ref={rootRef} className="relative w-full">
      <input
        id="hub-search"
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls="hub-search-results"
        aria-autocomplete="list"
        autoComplete="off"
        value={query}
        placeholder="搜索项目…"
        aria-label="搜索项目"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          if (query.trim() && hits.length > 0) setOpen(true)
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      />

      {showDropdown ? (
        <div
          id="hub-search-results"
          role="listbox"
          aria-label="搜索结果"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-auto rounded-md border border-[var(--border)] bg-[var(--panel)] shadow-lg"
        >
          {visible.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--text-dim)]">
              {loading ? '搜索中…' : '没有匹配的项目'}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)]/50">
              {visible.map((hit, index) => {
                const isActive = index === active
                return (
                  <li key={hit.nodeId} role="option" aria-selected={isActive}>
                    <button
                      type="button"
                      title={hit.path ?? hit.name}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(hit)}
                      className={`flex w-full flex-col gap-0.5 px-2 py-1.5 text-left focus:outline-none ${
                        isActive ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--border)]/30'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <KIND_ICON kind={hit.kind} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text)]">
                          {labelOf(hit)}
                        </span>
                        <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--accent)]/15 px-1.5 text-[10px] text-[var(--accent)]">
                          {hit.matchedOn === 'tag' ? <Tag className="h-2.5 w-2.5" aria-hidden /> : null}
                          {MATCH_LABEL[hit.matchedOn] ?? hit.matchedOn}
                        </span>
                      </span>
                      {hit.path ? (
                        <span className="pl-6 text-[11px] text-[var(--text-dim)]">
                          {truncateMiddle(hit.path)}
                        </span>
                      ) : null}
                      {hit.snippet ? (
                        <span className="pl-6 text-[11px] text-[var(--text-dim)]">
                          <Snippet text={hit.snippet} query={query} />
                        </span>
                      ) : null}
                      <span className="sr-only">{KIND_LABEL[hit.kind]}</span>
                    </button>
                  </li>
                )
              })}
              {hiddenCount > 0 ? (
                <li className="px-3 py-1.5 text-[11px] text-[var(--text-dim)]">+{hiddenCount}</li>
              ) : null}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

export { SearchBox }
