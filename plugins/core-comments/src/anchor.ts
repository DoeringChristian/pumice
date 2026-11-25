/**
 * Text anchors for comments (docs/plan/09): the quoted text plus some context and the last known
 * offset, so a comment finds its text again after edits made outside the editor.
 */
export interface TextAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  /** Offset of `exact` when the anchor was last saved. */
  start: number;
}

const CONTEXT = 32;
/** How much of the context has to match for a short text to be found. */
const ENOUGH = 8;
/** From this length on a text is taken for the same without any context. */
const DISTINCT = 16;

export function createAnchor(text: string, from: number, to: number): TextAnchor {
  return {
    exact: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - CONTEXT), from),
    suffix: text.slice(to, to + CONTEXT),
    start: from,
  };
}

/** Length of the common suffix of `a` and `b`. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where the anchor's text is now: the occurrence of `exact` whose surrounding text matches the
 * saved context best, ties broken by closeness to the old offset. Null when the text is gone.
 */
export function resolveAnchor(
  text: string,
  anchor: TextAnchor,
): { from: number; to: number } | null {
  if (!anchor.exact) {
    const at = Math.min(anchor.start, text.length);
    return { from: at, to: at };
  }
  // Fast path: still in place.
  if (text.startsWith(anchor.exact, anchor.start)) {
    const end = anchor.start + anchor.exact.length;
    const p = text.slice(Math.max(0, anchor.start - anchor.prefix.length), anchor.start);
    const s = text.slice(end, end + anchor.suffix.length);
    if (p === anchor.prefix && s === anchor.suffix) return { from: anchor.start, to: end };
  }
  let best: { from: number; score: number; context: number } | null = null;
  for (let i = text.indexOf(anchor.exact); i >= 0; i = text.indexOf(anchor.exact, i + 1)) {
    const before = text.slice(Math.max(0, i - CONTEXT), i);
    const after = text.slice(i + anchor.exact.length, i + anchor.exact.length + CONTEXT);
    const context = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
    // Context dominates; distance only separates equally good candidates.
    const score = context * 1e6 - Math.abs(i - anchor.start);
    if (!best || score > best.score) best = { from: i, score, context };
  }
  // A word is found in many places: only its surroundings tell that this is the one.
  const known = Math.min(ENOUGH, anchor.prefix.length + anchor.suffix.length);
  if (best && best.context < known && anchor.exact.length < DISTINCT) return null;
  return best ? { from: best.from, to: best.from + anchor.exact.length } : null;
}

/** Where a text that is gone used to be: behind what stood before it, else its last offset. */
export function formerPlace(text: string, anchor: TextAnchor): number {
  const at = anchor.prefix.trim() ? text.lastIndexOf(anchor.prefix) : -1;
  if (at >= 0) return at + anchor.prefix.length;
  const next = anchor.suffix.trim() ? text.indexOf(anchor.suffix) : -1;
  return next >= 0 ? next : Math.min(anchor.start, text.length);
}
