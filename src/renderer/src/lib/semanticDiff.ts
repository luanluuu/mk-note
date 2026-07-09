/**
 * Semantic change detection for prompt regeneration decisions.
 *
 * Problem: Naive string equality triggers regeneration on trivial edits
 * (adding a trailing period, extra spaces, a blank line). This wastes an
 * AI round-trip and makes the UI feel twitchy.
 *
 * Solution: Normalize both texts (collapse whitespace, trim, strip trailing
 * punctuation) before comparing. If the normalized forms are identical OR
 * very similar (Levenshtein-based ratio above threshold), treat them as
 * semantically unchanged.
 */

/** Strip characters that don't change meaning:
 *  - trailing punctuation (。.!！?？;；,，)
 *  - all whitespace is collapsed to single spaces
 *  - leading/trailing whitespace trimmed
 *  - multiple newlines collapsed to one */
function normalize(s: string): string {
  return s
    // Collapse all whitespace runs (spaces, tabs, newlines) to a single space.
    .replace(/\s+/g, ' ')
    // Trim leading/trailing.
    .trim()
    // Strip trailing CJK + ASCII punctuation that doesn't change meaning
    // when added/removed at the end of a sentence.
    .replace(/[。.!！?？;；,，、]+$/u, '')
}

/** Compute Levenshtein distance between two strings.
 *  Used to derive a similarity ratio. Short-circuits if either is empty. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  // Single-row DP (space-optimized).
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Similarity ratio in [0, 1]. 1 = identical, 0 = completely different. */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  const dist = levenshtein(a, b)
  return 1 - dist / maxLen
}

/** Threshold above which two normalized texts are considered semantically
 *  unchanged. 0.95 means up to 5% of characters can differ (typos, minor
 *  wording tweaks) without triggering regeneration. Tuned for typical
 *  prompt-length inputs (50-2000 chars). */
const SIMILARITY_THRESHOLD = 0.95

/** Minimum length below which ANY edit counts as a semantic change.
 *  Short texts are sensitive — a single word swap in a 10-char prompt
 *  completely changes intent, so we don't apply fuzzy matching. */
const SHORT_TEXT_THRESHOLD = 50

/** Returns true if `oldText` and `newText` are semantically different
 *  (i.e., regeneration is warranted). Returns false if they're close
 *  enough that regeneration would be wasteful. */
export function hasSemanticChange(oldText: string, newText: string): boolean {
  if (oldText === newText) return false
  // Different lengths by a large margin → definitely changed.
  // (Avoids running Levenshtein on very different-length inputs.)
  const lenDiff = Math.abs(oldText.length - newText.length)
  const maxLen = Math.max(oldText.length, newText.length)
  if (maxLen > 0 && lenDiff / maxLen > 0.2) return true

  const normOld = normalize(oldText)
  const normNew = normalize(newText)
  if (normOld === normNew) return false

  // For short texts, any normalized difference counts as a change.
  if (normOld.length < SHORT_TEXT_THRESHOLD || normNew.length < SHORT_TEXT_THRESHOLD) {
    return true
  }

  const sim = similarity(normOld, normNew)
  return sim < SIMILARITY_THRESHOLD
}
