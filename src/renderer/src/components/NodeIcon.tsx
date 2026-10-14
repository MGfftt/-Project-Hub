import { memo, useMemo, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { TreeNode } from '@shared/types'
import { autoIconName, defForNode, isBuiltinIcon, mediaUrl } from '@renderer/lib/treeIcons'
import { resolveLucideIcon } from '@renderer/lib/lucideIcons'
import { statusColor } from '@renderer/lib/colors'
import { t } from '@renderer/lib/i18n'

/** The slice of a lucide-react component this file needs. */
type DynIcon = LucideIcon

/* ---------------------------------------------------------------------------
 * NodeIcon — §8.3 / §9.2. One place decides how a node is drawn, so the tree,
 * the detail panel and the search results never disagree.
 *
 *   auto    a built-in glyph inferred from the scanner marker and the name
 *   lucide  a named glyph from the frozen built-in set
 *   emoji   the character itself, sized to match the glyphs
 *   image   an imported asset, served from the app's own `hub-media://` store
 *
 * The optional 8px status dot (§9.2) sits at the icon's top-right corner, 2px
 * outside it, and is the only part that depends on `node.status`.
 * ------------------------------------------------------------------------ */

export interface NodeIconProps {
  node: TreeNode | undefined | null
  /** Glyph box in px. §9.1 pins the tree to 16. */
  size?: number
  /** Renders the status dot (tree rows only; the detail panel shows status as text). */
  withStatus?: boolean
  className?: string
}

/** Archived nodes desaturate (§9.2 rule 6). */
function filterFor(node: TreeNode | undefined | null): string | undefined {
  return node?.status === 'archived' ? 'grayscale(1) opacity(0.65)' : undefined
}

/**
 * The glyph an `auto` node resolves to, as a *name*. Exported so the icon
 * picker's 「自动」 tab previews exactly what the tree will draw (§8.4).
 *
 * Precedence is the frozen one: a missing disk path warns first, a virtual
 * group is a container, a code-looking project is a code project, and anything
 * else falls through to the shared name rules in lib/treeIcons.
 *
 * The frozen 46-glyph built-in set has no `folder-tree`, `folder-code` or
 * `alert-triangle` entry, so `layers`, `file-code` and the amber
 * `<TriangleAlert>` drawn below are their equivalents. Every value returned
 * here is either a real `BUILTIN_ICONS` name or that one warning glyph.
 */
export function inferAutoIcon(node: TreeNode | undefined | null): string {
  if (!node) return 'folder'
  if (node.path_missing === 1) return 'alert-triangle'
  if (node.kind === 'group' && !node.path) return 'layers'
  if (node.kind === 'project' && /api|server|service|lib|core|sdk/i.test(node.name)) {
    return 'file-code'
  }
  return autoIconName(node)
}

export const NodeIcon = memo(function NodeIcon({
  node,
  size = 16,
  withStatus = false,
  className
}: NodeIconProps): JSX.Element {
  const [failed, setFailed] = useState(false)

  const def = useMemo(() => defForNode(node), [node])
  /* §8.3 — a `lucide` node stores an icon name. The frozen built-in set is drawn
   * inline (no dependency on the library's unstable names); a name outside that
   * set is resolved from the static §8.4 table in lib/lucideIcons, falling back
   * to the inferred auto glyph so an unknown name still renders something. */
  const DynamicIcon = useMemo<DynIcon | null>(() => {
    if (node?.icon_type !== 'lucide' || !node.icon_value) return null
    if (isBuiltinIcon(node.icon_value)) return null
    return (resolveLucideIcon(node.icon_value) as DynIcon | undefined) ?? null
  }, [node?.icon_type, node?.icon_value])
  const emoji = node?.icon_type === 'emoji' ? node.icon_value : null
  const image = node?.icon_type === 'image' && node.icon_value && !failed ? node.icon_value : null
  const title =
    node?.icon_type === 'lucide' && node.icon_value ? node.icon_value : inferAutoIcon(node)
  /* Only an inferred icon may be replaced by the warning: an emoji or an
   * imported image is an explicit user choice and is left alone. */
  const warnMissing =
    node != null &&
    node.path_missing === 1 &&
    (node.icon_type === 'auto' || node.icon_type == null)

  const box = (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, filter: filterFor(node) }}
    >
      {warnMissing ? (
        /* §9.2 — a missing disk path is drawn as an amber warning. */
        <TriangleAlert
          size={size}
          className="text-amber-500 dark:text-amber-400"
          role="img"
          aria-label={t('tree.pathMissing')}
        />
      ) : image ? (
        <img
          src={mediaUrl(image)}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailed(true)}
          className="rounded-[3px] object-contain"
        />
      ) : emoji ? (
        <span aria-hidden style={{ fontSize: Math.round(size * 0.92), lineHeight: 1 }}>
          {emoji}
        </span>
      ) : DynamicIcon ? (
        <DynamicIcon size={size} className="shrink-0" aria-hidden />
      ) : def ? (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          role={title ? 'img' : undefined}
          aria-label={title}
          aria-hidden={title ? undefined : true}
        >
          <path d={def.path} />
          {def.extra ? <path d={def.extra} /> : null}
        </svg>
      ) : (
        /* No glyph at all: a neutral square outline, never an empty gap. */
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          aria-hidden="true"
        >
          <rect x="4" y="4" width="16" height="16" rx="3" />
        </svg>
      )}

      {withStatus && node ? (
        <span
          aria-hidden
          className="absolute rounded-full"
          style={{
            width: 8,
            height: 8,
            top: -2,
            right: -2,
            backgroundColor: statusColor(node.status),
            boxShadow: '0 0 0 1.5px var(--panel)'
          }}
        />
      ) : null}
    </span>
  )

  return className ? <span className={className}>{box}</span> : box
})

export default NodeIcon
