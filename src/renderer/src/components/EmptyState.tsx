import type { CSSProperties, ReactNode } from 'react'

export interface EmptyStateProps {
  title: string
  /** One short line explaining what the user can do here. */
  description?: string
  /** Optional primary action; rendered only when both props are present. */
  actionLabel?: string
  onAction?: () => void
  /** Extra secondary actions (e.g. 「添加根目录」 plus 「导入」). */
  children?: ReactNode
  className?: string
}

/**
 * §9.6 空态: a centred inline-SVG illustration (hub/tree glyph, no external
 * asset), a title, one line of copy and an optional primary action.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  children,
  className
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 px-6 py-10 text-center ${className ?? ''}`}
    >
      <HubGlyph />
      <p className="text-sm font-medium text-[var(--text)]">{title}</p>
      {description ? (
        <p className="max-w-sm text-xs leading-5 text-[var(--text-dim)]">{description}</p>
      ) : null}
      {actionLabel && onAction ? (
        <button type="button" className="btn btn-primary mt-1" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      {children}
    </div>
  )
}

/**
 * The glyph: three satellites (project / folder / annotated node) orbiting a hub
 * node, drawn with the same 1.6px stroke language as the icon set (§9.3).
 */
function HubGlyph(): JSX.Element {
  const accent: CSSProperties = { stroke: 'var(--accent)' }
  const dim: CSSProperties = { stroke: 'var(--text-dim)' }
  const fillPanel: CSSProperties = { fill: 'var(--panel)' }
  return (
    <svg
      width="104"
      height="80"
      viewBox="0 0 104 80"
      fill="none"
      role="img"
      aria-label="项目库示意图"
      className="shrink-0"
    >
      <path d="M52 40 24 20M52 40h28M52 40 30 64" stroke="var(--border)" strokeWidth="1.4" />
      <path
        d="M24 20h14m0 0 4-4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H26a2 2 0 0 1-2-2V22a2 2 0 0 1 2-2Z"
        style={dim}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M70 32h16a2 2 0 0 0 2-2V18a2 2 0 0 0-2-2H70a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Zm4-8h8m-4 0v6"
        fill="none"
        style={accent}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M36 58h20a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2H36a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2Zm6-6 4 3 4-3"
        fill="none"
        style={dim}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="52" cy="40" r="9" style={fillPanel} stroke="var(--accent)" strokeWidth="1.8" />
      <circle cx="52" cy="40" r="3" fill="var(--accent)" />
      <circle cx="52" cy="40" r="16" stroke="var(--accent)" strokeOpacity="0.18" strokeWidth="1.4" />
    </svg>
  )
}

export default EmptyState
