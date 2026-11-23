import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
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
  return Decoration.set(found, true);
}

export const texHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
