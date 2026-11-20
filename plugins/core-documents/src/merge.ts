import fastDiff from 'fast-diff';
import { diff3Merge } from 'node-diff3';
import type * as Y from 'yjs';

export interface MergeResult {
  text: string;
  /** False if some region was changed differently on both sides; `text` then keeps ours there. */
  clean: boolean;
}

/** Hunks larger than this aren't retried character by character (quadratic). */
const MAX_CHAR_MERGE = 20_000;

function isSingleLine(text: string): boolean {
  const i = text.indexOf('\n');
  return i === -1 || i === text.length - 1;
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/**
 * Three-way merge of text. Line-based first; conflicting hunks are retried at character
 * level, so edits to different parts of the same line merge cleanly. Pure insertions at the
 * same position on both sides are kept in order (ours, then theirs) rather than conflicting.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs || theirs === base) return { text: ours, clean: true };
  if (ours === base) return { text: theirs, clean: true };
  return mergeTokens(lines(ours), lines(base), lines(theirs), true);
}

function mergeTokens(a: string[], o: string[], b: string[], retryChars: boolean): MergeResult {
  let text = '';
  let clean = true;
  for (const region of diff3Merge(a, o, b)) {
    if (region.ok) {
      text += region.ok.join('');
      continue;
    }
    const c = region.conflict!;
    const [ca, co, cb] = [c.a.join(''), c.o.join(''), c.b.join('')];
    if (co === '') {
      text += ca + cb;
      continue;
    }
    // Character-level merging is only trustworthy within a single line: across lines, the
    // character LCS can align unrelated text and "cleanly" drop an insertion.
    if (
      retryChars &&
      isSingleLine(ca) &&
      isSingleLine(co) &&
      isSingleLine(cb) &&
      ca.length + co.length + cb.length <= MAX_CHAR_MERGE
    ) {
      const sub = mergeTokens([...ca], [...co], [...cb], false);
      if (sub.clean) {
        text += sub.text;
        continue;
      }
    }
    clean = false;
    text += ca;
  }
  return { text, clean };
}

/** Encodes each distinct line as one UTF-16 code unit so a char diff becomes a line diff. */
function encodeLines(
  a: string,
  b: string,
): { a: string; b: string; decode: (s: string) => string } {
  const codes = new Map<string, string>();
  const table: string[] = [];
  const encode = (text: string) =>
    lines(text)
      .map((line) => {
        let code = codes.get(line);
        if (code === undefined) {
          let n = table.length + 1;
          if (n >= 0xd800) n += 0x800; // skip the surrogate range
          code = String.fromCharCode(n);
          codes.set(line, code);
          table.push(line);
        }
        return code;
      })
      .join('');
  const encA = encode(a);
  const encB = encode(b);
  const decode = (s: string) => {
    let out = '';
    for (const ch of s) {
      let n = ch.charCodeAt(0);
      if (n >= 0xd800 + 0x800) n -= 0x800;
      out += table[n - 1];
    }
    return out;
  };
  return { a: encA, b: encB, decode };
}

/**
 * Turns `ytext` into `target` with a small set of inserts and deletes. Diffs by line first and
 * by character only inside replaced lines, so concurrent remote edits anchored to untouched
 * lines stay where they were (a pure character diff can shuffle text across lines).
 */
export function applyTextDiff(ytext: Y.Text, target: string): void {
  const current = ytext.toString();
  if (current === target) return;
  const encoded = encodeLines(current, target);
  if (encoded.a.length + encoded.b.length > 0xf000) {
    applyCharDiff(ytext, 0, current, target);
    return;
  }
  const ops = fastDiff(encoded.a, encoded.b).map(
    ([op, chunk]) => [op, encoded.decode(chunk)] as const,
  );
  let pos = 0;
  for (let i = 0; i < ops.length; i++) {
    const [op, chunk] = ops[i]!;
    const next = ops[i + 1];
    if (op === fastDiff.EQUAL) {
      pos += chunk.length;
    } else if (next && next[0] !== fastDiff.EQUAL && next[0] !== op) {
      // A replaced block of lines: refine at character level.
      const [removed, added] = op === fastDiff.DELETE ? [chunk, next[1]] : [next[1], chunk];
      pos += applyCharDiff(ytext, pos, removed, added);
      i++;
    } else if (op === fastDiff.DELETE) {
      ytext.delete(pos, chunk.length);
    } else {
      ytext.insert(pos, chunk);
      pos += chunk.length;
    }
  }
}

/** Replaces `from` (at `offset`) with `to` using a character diff. Returns `to.length`. */
function applyCharDiff(ytext: Y.Text, offset: number, from: string, to: string): number {
  let pos = offset;
  for (const [op, chunk] of fastDiff(from, to)) {
    if (op === fastDiff.EQUAL) pos += chunk.length;
    else if (op === fastDiff.DELETE) ytext.delete(pos, chunk.length);
    else {
      ytext.insert(pos, chunk);
      pos += chunk.length;
    }
  }
  return pos - offset;
}
