/**
 * Fuzzy and exact name matching used by the scanner and the renderer.
 *
 * Lives in `shared` (not `renderer`) because two callers with different
 * behaviours need the same score function:
 *   - the scanner, to decide "an existing node already represents this folder"
 *     when it cannot match by path (folder was renamed/moved — §14.4);
 *   - the palette, to rank search hits.
 * No Node or DOM APIs.
 */

export interface MatchResult {
  matched: boolean
  score: number
  /** [start, end) ranges of `haystack` covered by the query, for highlighting. */
  ranges: Array<[number, number]>
}

const WORD_BOUNDARY = /[\s\-_./\\()[\]]/

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || WORD_BOUNDARY.test(ch)
}

/**
 * Subsequence matcher with bonuses for word starts and consecutive runs.
 * Case-insensitive. Returns `matched:false` when any query char is missing.
 */
export function fuzzyMatch(haystack: string, query: string): MatchResult {
  const hay = haystack
  const q = query.trim()
  // An empty query matches NOTHING. The alternative (matching everything with a
  // score of 0) makes a matcher claim a match it never made, and forces every
  // caller to special-case the empty string anyway — `search:query` in
  // src/main/ipc/main.ts already returns `[]` for it.
  if (q === '') return { matched: false, score: 0, ranges: [] }

  const lowerHay = hay.toLowerCase()
  const lowerQ = q.toLowerCase()

  // Fast path: contiguous substring beats everything.
  const direct = lowerHay.indexOf(lowerQ)
  if (direct >= 0) {
    const boundaryBonus = isBoundary(lowerHay[direct - 1]) ? 24 : 0
    const startBonus = direct === 0 ? 40 : 0
    return {
      matched: true,
      score: 1000 + q.length * 12 + boundaryBonus + startBonus - direct,
      ranges: [[direct, direct + q.length]]
    }
  }

  let qi = 0
  let score = 0
  let streak = 0
  let prevIndex = -2
  const ranges: Array<[number, number]> = []

  for (let i = 0; i < lowerHay.length && qi < lowerQ.length; i++) {
    if (lowerHay[i] !== lowerQ[qi]) continue
    const boundary = isBoundary(lowerHay[i - 1])
    if (i === prevIndex + 1) streak += 1
    else streak = 0
    score += 10 + streak * 6 + (boundary ? 18 : 0) + (i === 0 ? 12 : 0)
    score -= Math.min(i, 30) * 0.4

    const last = ranges[ranges.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else ranges.push([i, i + 1])

    prevIndex = i
    qi += 1
  }

  if (qi < lowerQ.length) return { matched: false, score: -1, ranges: [] }
  // Exact-length matches are worse than substring matches; scale by coverage.
  score -= (lowerHay.length - lowerQ.length) * 0.6
  return { matched: true, score, ranges }
}

/** Rank `items` by the best of several candidate strings per item. */
export function rankByMatch<T>(
  items: T[],
  query: string,
  extract: (item: T) => Array<string | null | undefined>
): Array<{ item: T; score: number; ranges: Array<[number, number]>; on: string }> {
  const out: Array<{ item: T; score: number; ranges: Array<[number, number]>; on: string }> = []
  for (const item of items) {
    let best: { score: number; ranges: Array<[number, number]>; on: string } | null = null
    for (const candidate of extract(item)) {
      if (!candidate) continue
      const m = fuzzyMatch(candidate, query)
      if (!m.matched) continue
      if (!best || m.score > best.score) best = { score: m.score, ranges: m.ranges, on: candidate }
    }
    if (best) out.push({ item, ...best })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Similarity in [0,1] for "is this the same folder, renamed?" decisions. */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim()
  const y = b.toLowerCase().trim()
  if (x === y) return 1
  if (!x || !y) return 0
  const shorter = x.length <= y.length ? x : y
  const longer = x.length <= y.length ? y : x
  if (longer.includes(shorter) && shorter.length >= 3) return 0.85 + 0.15 * (shorter.length / longer.length)
  const m = fuzzyMatch(longer, shorter)
  if (!m.matched) return 0
  return Math.max(0, Math.min(0.8, m.score / 1000))
}
