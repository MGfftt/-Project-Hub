export interface SkeletonProps {
  /** Number of placeholder rows. */
  rows?: number
  /** Bar width pattern; defaults to a full-width bar per row. */
  variant?: 'row' | 'line' | 'block'
  className?: string
}

/**
 * §9.6 加载态: skeletons, never spinners.
 *
 * The shimmer itself lives in `styles.css` (`.skeleton`), so every panel that
 * needs a placeholder reuses the same keyframes and the same reduced-motion
 * opt-out.
 */
export function Skeleton({ rows = 3, variant = 'row', className }: SkeletonProps): JSX.Element {
  const count = Math.max(1, Math.floor(rows))
  return (
    <div
      className={`flex flex-col gap-2 ${className ?? ''}`}
      role="status"
      aria-busy="true"
      aria-label="加载中"
    >
      {Array.from({ length: count }, (_, i) => {
        if (variant === 'line') {
          return <span key={i} className="skeleton block h-3 w-full" aria-hidden />
        }
        if (variant === 'block') {
          return <span key={i} className="skeleton block h-20 w-full" aria-hidden />
        }
        return (
          <span key={i} className="flex items-center gap-2" aria-hidden>
            <span className="skeleton h-4 w-4 shrink-0 rounded" />
            <span
              className="skeleton h-3"
              style={{ width: `${[72, 54, 63, 44, 68][i % 5]}%` }}
            />
          </span>
        )
      })}
    </div>
  )
}

export default Skeleton
