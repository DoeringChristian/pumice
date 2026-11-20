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
  let best: { from: number; score: number } | null = null;
  for (let i = text.indexOf(anchor.exact); i >= 0; i = text.indexOf(anchor.exact, i + 1)) {
    const before = text.slice(Math.max(0, i - CONTEXT), i);
    const after = text.slice(i + anchor.exact.length, i + anchor.exact.length + CONTEXT);
    const context = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
    // Context dominates; distance only separates equally good candidates.
    const score = context * 1e6 - Math.abs(i - anchor.start);
    if (!best || score > best.score) best = { from: i, score };
  }
  return best ? { from: best.from, to: best.from + anchor.exact.length } : null;
}
