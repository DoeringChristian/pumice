/**
 * Text objects for what markdown puts between the same marks on both sides: `i$` / `a$` for
 * a formula, and likewise `*`, `_`, `~`, `=` (and `|` for the cell of a table). `ci$` changes
 * the formula, `da*` deletes bold or italic text with its stars. Marks that are doubled
 * (`**`, `$$`, `~~`, `==`) count as one. A formula between `$$` may run over several lines.
 */

export const DELIMITERS = ['$', '*', '_', '~', '=', '|'];

export interface Span {
  from: number;
  to: number;
}

/** The runs of `mark` in `text` (not the ones behind a backslash), as offsets. */
function runs(text: string, mark: string): Span[] {
  const out: Span[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] !== mark) continue;
    let end = i;
    while (text[end] === mark) end++;
    out.push({ from: i, to: end });
    i = end - 1;
  }
  return out;
}

/**
 * The piece between two runs of `mark` that `at` is in or on (else the next one after it), in
 * `text`. `inner`: without the marks. A table's cells lie between every two bars; the others
 * pair up from the start (first with second, third with fourth).
 */
export function delimited(
  text: string,
  mark: string,
  at: number,
  inner: boolean,
): Span | undefined {
  const marks = runs(text, mark);
  const pairs: [Span, Span][] = [];
  if (mark === '|')
    for (let i = 0; i + 1 < marks.length; i++) pairs.push([marks[i]!, marks[i + 1]!]);
  else {
    // A closing run is as long as the one that opened (`**a*b**` is one piece of bold text).
    for (let i = 0; i < marks.length; i++) {
      const open = marks[i]!;
      const j = marks.findIndex((m, k) => k > i && m.to - m.from === open.to - open.from);
      const close = marks[j === -1 ? i + 1 : j];
      if (!close) break;
      pairs.push([open, close]);
      i = marks.indexOf(close);
    }
  }
  const pair =
    pairs.find(([a, b]) => at >= a.from && at < b.to) ?? pairs.find(([a]) => a.from > at);
  if (!pair) return undefined;
  const [open, close] = pair;
  return inner ? { from: open.to, to: close.from } : { from: open.from, to: close.to };
}

/** The same in a note: on the line of `at`, or (for `$`) in a `$$` block around it. */
export function delimitedIn(
  doc: string,
  mark: string,
  at: number,
  inner: boolean,
): Span | undefined {
  const start = doc.lastIndexOf('\n', at - 1) + 1;
  const stop = doc.indexOf('\n', at);
  const line = doc.slice(start, stop === -1 ? doc.length : stop);
  const within = delimited(line, mark, at - start, inner);
  // A lone `$$` on the line is the edge of a block, not a pair.
  const lone = mark === '$' && runs(line, '$').length === 1;
  if (within && !lone) return { from: start + within.from, to: start + within.to };
  if (mark !== '$') return undefined;
  const fences = runs(doc, '$').filter((r) => r.to - r.from === 2);
  for (let i = 0; i + 1 < fences.length; i += 2) {
    const open = fences[i]!;
    const close = fences[i + 1]!;
    if (at < open.from || at >= close.to) continue;
    if (!inner) return { from: open.from, to: close.to };
    // Without the line breaks that set the formula apart from its marks.
    let from = open.to;
    let to = close.from;
    if (doc[from] === '\n') from++;
    if (doc[to - 1] === '\n' && to - 1 >= from) to--;
    return { from, to };
  }
  return within ? { from: start + within.from, to: start + within.to } : undefined;
}
