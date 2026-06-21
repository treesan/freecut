/**
 * Fuzzy word matching for transcript search.
 *
 * ASR transcripts are noisy — the same spoken word can land as different
 * spellings ("Ved" / "Vid" / "Viet"), so an exact substring search silently
 * misses occurrences. This provides an exact-first / edit-distance-fallback
 * match: precise searches stay precise, and only when an exact search comes up
 * empty do we widen to typo-tolerant matches (flagged `approximate` so the UI
 * can distinguish them).
 */

/** Fold case + diacritics; keeps spaces and punctuation for substring parity. */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

/** Letters/numbers only — the comparison key for edit-distance matching. */
function wordKey(text: string): string {
  return normalizeForSearch(text).replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Levenshtein distance with an early-exit ceiling: returns a value > `max` as
 * soon as the distance is known to exceed it, so per-word checks stay cheap.
 */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0
  const al = a.length
  const bl = b.length
  if (al === 0) return bl
  if (bl === 0) return al
  if (Math.abs(al - bl) > max) return max + 1

  let prev = Array.from({ length: bl + 1 }, (_, j) => j)
  let curr = new Array<number>(bl + 1)

  for (let i = 1; i <= al; i++) {
    curr[0] = i
    let rowMin = i
    const ac = a.charCodeAt(i - 1)
    for (let j = 1; j <= bl; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1
      const value = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      curr[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return max + 1
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[bl] ?? max + 1
}

/** Max edit distance allowed for a fuzzy word match of the given length. */
export function fuzzyThreshold(length: number): number {
  if (length <= 3) return 1
  if (length <= 6) return 2
  return 3
}

/** Shortest query eligible for fuzzy fallback (avoids noisy 1–2 char hits). */
const MIN_FUZZY_QUERY = 3

export interface TranscriptMatchResult {
  /** Token indices that matched, in order. */
  indices: number[]
  /** True when results came from the edit-distance fallback, not exact search. */
  approximate: boolean
}

/**
 * Match `query` against per-token `words` (each entry is one token's text).
 * Exact substring first; if that finds nothing and the query is a single word
 * of usable length, fall back to typo-tolerant matching.
 */
export function findTranscriptWordMatches(
  words: readonly string[],
  query: string,
): TranscriptMatchResult {
  const trimmed = query.trim()
  if (!trimmed) return { indices: [], approximate: false }

  const needle = normalizeForSearch(trimmed)
  const exact: number[] = []
  for (let i = 0; i < words.length; i++) {
    if (normalizeForSearch(words[i] ?? '').includes(needle)) exact.push(i)
  }

  // Exact hits, or a multi-word phrase (cross-word fuzzing is out of scope):
  // return precise results untouched.
  if (exact.length > 0 || /\s/.test(trimmed)) {
    return { indices: exact, approximate: false }
  }

  const key = wordKey(trimmed)
  if (key.length < MIN_FUZZY_QUERY) return { indices: exact, approximate: false }

  const max = fuzzyThreshold(key.length)
  const fuzzy: number[] = []
  for (let i = 0; i < words.length; i++) {
    if (boundedLevenshtein(key, wordKey(words[i] ?? ''), max) <= max) fuzzy.push(i)
  }
  return { indices: fuzzy, approximate: fuzzy.length > 0 }
}
