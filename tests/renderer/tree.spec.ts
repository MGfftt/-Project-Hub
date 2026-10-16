import { describe, expect, it } from 'vitest'
import type { NodeKind, TreeNode } from '../../src/shared/types'
import { diskMetric, findParent, ungroupTarget } from '../../src/renderer/src/lib/tree'

/*
 * §7.8 — the two rules the panels rest on when they offer to unbind a node:
 *   findParent must see through the nest, and ungroupTarget must only ever
 *   answer for a node held by a *virtual* group — a node inside a real folder
 *   keeps the structure the disk already has.
 * Plus §9.7's metric rule: a node without a path has no size to wait for.
 */

function node(id: number, kind: NodeKind = 'project', children: TreeNode[] = []): TreeNode {
  return {
    id,
    root_id: 1,
    parent_id: null,
    name: `n${id}`,
    display_name: null,
    path: kind === 'group' ? null : `/tmp/root/n${id}`,
    kind,
    status: 'active',
    color: null,
    priority: 0,
    sort_order: 0,
    tags: [],
    icon_type: 'auto',
    icon_value: null,
    path_missing: 0,
    created_at: 0,
    updated_at: 0,
    children
  }
}

/* root: project 1, folder 2, group 5 [ project 3, group 6 [ note 4 ] ] */
const leaf = node(3)
const inner = node(6, 'group', [node(4, 'note')])
const group = node(5, 'group', [leaf, inner])
const forest = [node(1), node(2, 'folder'), group]

describe('findParent', () => {
  it('walks the nest and reports the container', () => {
    expect(findParent(forest, 3)?.id).toBe(5)
    expect(findParent(forest, 4)?.id).toBe(6)
  })

  it('returns null for a top-level node', () => {
    expect(findParent(forest, 1)).toBeNull()
    expect(findParent(forest, 999)).toBeNull()
  })
})

describe('ungroupTarget (§7.8)', () => {
  it('lifts a node out beside its group', () => {
    expect(ungroupTarget(forest, 3)).toEqual({ parentId: null, index: 3 })
  })

  it('lifts a top-level group out to the root beside it', () => {
    expect(ungroupTarget(forest, 6)).toEqual({ parentId: null, index: 3 })
  })

  it('lifts a node out of a group into the container above it', () => {
    /* `4` sits in group `6`, which itself sits in group `5`: unbinding goes one
     * level up at a time, so it lands inside `5`, right behind `6`. */
    expect(ungroupTarget(forest, 4)).toEqual({ parentId: 5, index: 2 })
  })

  it('has nothing to unbind for a node in a real folder or at the root', () => {
    const nested = [node(1, 'project', [node(7)])]
    expect(ungroupTarget(nested, 7)).toBeNull()
    expect(ungroupTarget(forest, 1)).toBeNull()
    expect(ungroupTarget(forest, 999)).toBeNull()
  })
})

describe('diskMetric (§9.7)', () => {
  it('reads 「—」 without a path and 「计算中…」 only while a real one is pending', () => {
    expect(diskMetric(null, null, String)).toBe('—')
    expect(diskMetric('/tmp/root/n1', null, String)).toBe('计算中…')
    expect(diskMetric('/tmp/root/n1', 42, String)).toBe('42')
  })
})
