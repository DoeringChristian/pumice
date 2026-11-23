import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';

/**
 * Colours for the TeX of a formula while its source is shown: commands, braces, the marks of
 * sub- and superscripts and columns, numbers and comments.
 */

export type TexToken = { from: number; to: number; kind: TexKind };
export type TexKind = 'command' | 'environment' | 'brace' | 'script' | 'number' | 'comment';

/** The parts of `tex` that get a colour of their own (offsets into `tex`). */
export function texTokens(tex: string): TexToken[] {
  const out: TexToken[] = [];
  for (let i = 0; i < tex.length;) {
    const c = tex[i]!;
    if (c === '%') {
      const end = tex.indexOf('\n', i);
      const to = end < 0 ? tex.length : end;
      out.push({ from: i, to, kind: 'comment' });
      i = to;
    } else if (c === '\\') {
      const name = /^[a-zA-Z]+\*?/.exec(tex.slice(i + 1))?.[0];
      // `\\`, `\,`, `\{`: two characters.
      const to = Math.min(tex.length, i + 1 + (name ? name.length : 1));
      out.push({ from: i, to, kind: 'command' });
      i = to;
      // The name of an environment, with the command that opens or closes it.
      if (name === 'begin' || name === 'end') {
        const env = /^\{([^{}\n]*)\}/.exec(tex.slice(i));
        if (env) {
          out.push({ from: i, to: i + 1, kind: 'brace' });
          out.push({ from: i + 1, to: i + 1 + env[1]!.length, kind: 'environment' });
          out.push({ from: i + env[0].length - 1, to: i + env[0].length, kind: 'brace' });
          i += env[0].length;
        }
      }
    } else if (c === '{' || c === '}') {
      out.push({ from: i, to: i + 1, kind: 'brace' });
      i++;
    } else if (c === '^' || c === '_' || c === '&') {
      out.push({ from: i, to: i + 1, kind: 'script' });
      i++;
    } else if (/\d/.test(c)) {
      const number = /^\d+(?:\.\d+)?/.exec(tex.slice(i))![0];
      out.push({ from: i, to: i + number.length, kind: 'number' });
      i += number.length;
    } else i++;
  }
  return out;
}

/** Marks where the cursor is in a formula's preview: nothing wide, as tall as a letter. */
const CARET = '{\\htmlClass{pm-math-caret}{\\mathstrut}}';

/**
 * `tex` with a mark where the cursor is (`offset` into it), for the preview of a formula that
 * is being written. The mark only goes where it cannot change what the formula means: not
 * into the name of a command, and not between a command and what it takes.
 */
export function withCaret(tex: string, offset: number): string {
  let at = Math.max(0, Math.min(tex.length, offset));
  for (let i = 0; i < tex.length && i < at;) {
    if (tex[i] === '%') {
      // In a comment there is nothing to show.
      const end = tex.indexOf('\n', i);
      if (end < 0 || end >= at) return tex;
      i = end + 1;
    } else if (tex[i] === '\\') {
      const name = /^[a-zA-Z]+\*?/.exec(tex.slice(i + 1))?.[0];
      if (name) {
        // Within `\\name`, or behind it where what it takes (or its limits) begins: in front
        // of it. Behind a command that stands alone (`\\alpha |`) the mark stays.
        const nameEnd = i + 1 + name.length;
        let end = nameEnd;
        while (tex[end] === ' ') end++;
        if (at < nameEnd || (at <= end && /^\s*[{[^_]/.test(tex.slice(at)))) at = i;
        i = end;
      } else {
        // `\\\\`, `\\{`, `\\,`: two characters that belong together.
        if (at === i + 1) at = i;
        i += 2;
      }
    } else i++;
  }
  return tex.slice(0, at) + CARET + tex.slice(at);
}

/**
 * A `$…$` formula that is being written and, right now, ends in a space: `$a + |$`. Read
 * strictly that is not a formula (a `$` after a space is a price: "$5 and $6"), so it would
 * stop being one at every space typed. With the cursor at its end it is taken for the formula
 * it is about to be. Columns within `line`; undefined if there is none at `column`.
 */
export function typedInlineMath(
  line: string,
  column: number,
): { from: number; to: number; tex: string } | undefined {
  // Only spaces between the cursor and the `$` that closes it.
  let close = column;
  while (close < line.length && (line[close] === ' ' || line[close] === '\t')) close++;
  if (line[close] !== '$' || line[close + 1] === '$' || line[close - 1] === '$') return undefined;
  for (let open = Math.min(column, close) - 1; open >= 0; open--) {
    if (line[open] !== '$') continue;
    // Not `\$`, not part of `$$`, and with something right behind it.
    if (line[open - 1] === '\\' || line[open - 1] === '$' || line[open + 1] === '$')
      return undefined;
    const tex = line.slice(open + 1, close);
    if (!tex.trim() || /^\s/.test(tex)) return undefined;
    // Without a space at its end it is a formula anyway.
    if (!/\s$/.test(tex)) return undefined;
    return { from: open, to: close + 1, tex };
  }
  return undefined;
}

/** The same, at the cursor of an editor: positions in the note. */
export function typedInlineMathAt(
  state: EditorState,
): { from: number; to: number; tex: string } | undefined {
  const sel = state.selection.main;
  if (!sel.empty) return undefined;
  const line = state.doc.lineAt(sel.head);
  if (line.length > 5000) return undefined;
  const found = typedInlineMath(line.text, sel.head - line.from);
  if (!found) return undefined;
  // Not in code, where a `$` is just a `$`.
  for (let node = syntaxTree(state).resolveInner(sel.head, -1); ;) {
    if (/Code|Frontmatter|Comment/.test(node.name)) return undefined;
    if (!node.parent) break;
    node = node.parent;
  }
  return { from: line.from + found.from, to: line.from + found.to, tex: found.tex };
}

const marks: Record<TexKind, Decoration> = {
  command: Decoration.mark({ class: 'cm-pm-tex-command' }),
  environment: Decoration.mark({ class: 'cm-pm-tex-environment' }),
  brace: Decoration.mark({ class: 'cm-pm-tex-brace' }),
  script: Decoration.mark({ class: 'cm-pm-tex-script' }),
  number: Decoration.mark({ class: 'cm-pm-tex-number' }),
  comment: Decoration.mark({ class: 'cm-pm-tex-comment' }),
};

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const found: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (!/^(InlineMath|InlineMathDisplay|MathBlock)$/.test(node.name)) return;
        const source = state.doc.sliceString(node.from, node.to);
        // Without the `$` or `$$` at both ends.
        const lead = /^\$+/.exec(source)?.[0].length ?? 0;
        const tail = /\$+\s*$/.exec(source.slice(lead))?.[0].length ?? 0;
        const start = node.from + lead;
        for (const token of texTokens(source.slice(lead, source.length - tail)))
          found.push(marks[token.kind].range(start + token.from, start + token.to));
        return false;
      },
    });
  }
  // The formula that is being written at the cursor (see `typedInlineMath`).
  const typed = typedInlineMathAt(state);
  if (typed)
    for (const token of texTokens(typed.tex))
      found.push(marks[token.kind].range(typed.from + 1 + token.from, typed.from + 1 + token.to));
  return Decoration.set(found, true);
}

export const texHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      const typed = (state: EditorState) => typedInlineMathAt(state)?.from;
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        (u.selectionSet && typed(u.startState) !== typed(u.state))
      )
        this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
