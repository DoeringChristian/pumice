/** Text positions as references for agents and chats (docs/plan/09). */

export type LocationFormat = 'colon' | 'at';

export interface LineRange {
  /** 1-based lines and columns; `to` is inclusive of the last selected character's line. */
  fromLine: number;
  fromCol: number;
  toLine: number;
  toCol: number;
  empty: boolean;
}

/** Line/column range of a selection in `text` (offsets `from`..`to`). */
export function lineRange(text: string, from: number, to: number): LineRange {
  const at = (pos: number) => {
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    return { line, col: pos - (before.lastIndexOf('\n') + 1) + 1 };
  };
  const a = at(from);
  // A selection ending at the start of a line (whole lines selected) ends on the previous line.
  const end = to > from && text[to - 1] === '\n' ? to - 1 : to;
  const b = at(end);
  return { fromLine: a.line, fromCol: a.col, toLine: b.line, toCol: b.col, empty: from === to };
}

/** True when the selection covers whole lines (or is empty). */
function wholeLines(text: string, from: number, to: number): boolean {
  if (from === to) return true;
  const startsLine = from === 0 || text[from - 1] === '\n';
  const endsLine = to === text.length || text[to] === '\n' || text[to - 1] === '\n';
  return startsLine && endsLine;
}

/**
 * `Notes/a.md:12`, `Notes/a.md:12-14`, `Notes/a.md:12:5-12:20` (columns for partial lines);
 * or with `at`: `@Notes/a.md#L12`, `@Notes/a.md#L12-14`.
 */
export function formatLocation(
  path: string,
  text: string,
  from: number,
  to: number,
  format: LocationFormat = 'colon',
): string {
  const r = lineRange(text, from, to);
  const lines = r.fromLine === r.toLine ? `${r.fromLine}` : `${r.fromLine}-${r.toLine}`;
  if (format === 'at') return `@${path}#L${lines}`;
  if (wholeLines(text, from, to)) return `${path}:${lines}`;
  // toCol is the column after the last character; report the last character itself.
  return `${path}:${r.fromLine}:${r.fromCol}-${r.toLine}:${r.toCol - 1}`;
}

/** The location followed by the selected text in a fenced block (fence longer than any inside). */
export function formatLocationWithText(
  path: string,
  text: string,
  from: number,
  to: number,
  format: LocationFormat = 'colon',
): string {
  let selected = text.slice(from, to);
  if (from === to) {
    const start = text.lastIndexOf('\n', from - 1) + 1;
    const end = text.indexOf('\n', from);
    selected = text.slice(start, end < 0 ? text.length : end);
  }
  const longest = Math.max(2, ...[...selected.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${formatLocation(path, text, from, to, format)}\n${fence}markdown\n${selected.replace(/\n$/, '')}\n${fence}\n`;
}

const BLOCK_ID_AT_END = /\s\^([A-Za-z0-9-]+)\s*$/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

export type BlockTarget =
  | { kind: 'heading'; heading: string }
  | { kind: 'block'; id: string; insert?: { at: number; text: string } };

/**
 * What a link to the selection should point to: the heading if the selection starts on a heading
 * line, otherwise the block (paragraph, list item) containing the selection end, reusing its
 * `^block-id` or describing where to add a new one.
 */
export function blockTarget(text: string, pos: number, newId: () => string): BlockTarget {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const lineEndRaw = text.indexOf('\n', pos);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const heading = HEADING.exec(line);
  if (heading) return { kind: 'heading', heading: heading[1]! };
  // List items are their own blocks; paragraphs run until a blank line.
  let end = lineEnd;
  if (!/^\s*([-*+]|\d+[.)])\s/.test(line)) {
    while (end < text.length) {
      const nextEnd = text.indexOf('\n', end + 1);
      const next = text.slice(end + 1, nextEnd < 0 ? text.length : nextEnd);
      if (
        !next.trim() ||
        /^\s*([-*+]|\d+[.)]|#{1,6})\s/.test(next) ||
        /^\s*(```|~~~|\||>)/.test(next)
      )
        break;
      end = nextEnd < 0 ? text.length : nextEnd;
    }
  }
  const lastLineStart = text.lastIndexOf('\n', end - 1) + 1;
  const last = text.slice(lastLineStart, end);
  const existing = BLOCK_ID_AT_END.exec(last);
  if (existing) return { kind: 'block', id: existing[1]! };
  const id = newId();
  const trimmedEnd = lastLineStart + last.replace(/\s+$/, '').length;
  return { kind: 'block', id, insert: { at: trimmedEnd, text: ` ^${id}` } };
}

/** A short random block ID (Obsidian uses 6 lowercase alphanumerics). */
export function newBlockId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
