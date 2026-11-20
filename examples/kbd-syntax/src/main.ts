/**
 * Example: a markdown syntax extension, `++Ctrl+C++` → <kbd>Ctrl</kbd>+<kbd>C</kbd>.
 * Registers both parser halves (Lezer for the editor, micromark + mdast for reading view,
 * index and export) and an editor decoration for live preview.
 */
import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import type { InlineContext, MarkdownConfig } from '@lezer/markdown';
import { Editor, MarkdownSyntax, definePlugin } from '@pumice/api';

// --- Lezer (editor) ---------------------------------------------------------------------------

const lezer: MarkdownConfig = {
  defineNodes: ['Kbd', 'KbdMark'],
  parseInline: [
    {
      name: 'Kbd',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 43 || cx.char(pos + 1) !== 43) return -1;
        const close = cx.slice(pos + 2, cx.end).indexOf('++');
        if (close <= 0) return -1;
        const end = pos + 2 + close + 2;
        if (/\s/.test(cx.slice(pos + 2, pos + 3))) return -1;
        return cx.addElement(
          cx.elt('Kbd', pos, end, [
            cx.elt('KbdMark', pos, pos + 2),
            cx.elt('KbdMark', end - 2, end),
          ]),
        );
      },
      before: 'Emphasis',
    },
  ],
};

// --- micromark + mdast (reading view, index) --------------------------------------------------

type Effects = { enter(t: string): void; exit(t: string): void; consume(c: number | null): void };
type State = (code: number | null) => State | undefined;

const kbdConstruct = {
  name: 'kbd',
  tokenize(effects: Effects, ok: State, nok: State): State {
    let size = 0;
    let closing = 0;
    const start: State = (code) => {
      effects.enter('kbd');
      effects.consume(code);
      return second;
    };
    const second: State = (code) => {
      if (code !== 43) return nok(code);
      effects.consume(code);
      return first;
    };
    const first: State = (code) =>
      code === null || code === 32 || code < 0 ? nok(code) : inside(code);
    const inside: State = (code) => {
      if (code === null || code < -2) return nok(code); // end of text or line ending
      effects.consume(code);
      if (code === 43) {
        closing++;
        if (closing === 2 && size > 0) {
          effects.exit('kbd');
          return ok;
        }
      } else {
        closing = 0;
        size++;
      }
      return inside;
    };
    return start;
  },
};

const micromark = { text: { 43: kbdConstruct } };

const mdast = {
  enter: {
    kbd(
      this: { sliceSerialize(t: unknown): string; enter(n: unknown, t: unknown): void },
      token: unknown,
    ) {
      const keys = this.sliceSerialize(token).slice(2, -2).split('+').filter(Boolean);
      const hChildren = keys.flatMap((k, i) => [
        ...(i ? [{ type: 'text', value: '+' }] : []),
        { type: 'element', tagName: 'kbd', properties: {}, children: [{ type: 'text', value: k }] },
      ]);
      this.enter(
        {
          type: 'kbd',
          data: { hName: 'span', hProperties: { className: ['kbd-keys'] }, hChildren },
        },
        token,
      );
    },
  },
  exit: {
    kbd(this: { exit(t: unknown): void }, token: unknown) {
      this.exit(token);
    },
  },
};

// --- Editor decoration (live preview) ----------------------------------------------------------

const kbdMark = Decoration.mark({ class: 'cm-kbd' });
const hidden = Decoration.replace({});

function decorations(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'Kbd') return;
        const editing = cursor >= node.from && cursor <= node.to;
        if (!editing) out.push(hidden.range(node.from, node.from + 2));
        out.push(kbdMark.range(node.from + 2, node.to - 2));
        if (!editing) out.push(hidden.range(node.to - 2, node.to));
      },
    });
  }
  return Decoration.set(out, true);
}

export default definePlugin({
  activate(ctx) {
    ctx.register(
      ctx
        .use(MarkdownSyntax)
        .register({ name: 'kbd', lezer, micromark: micromark as never, mdast: mdast as never }),
    );
    ctx.register(
      ctx.use(Editor).registerExtension(() =>
        ViewPlugin.fromClass(
          class {
            decorations: DecorationSet;
            constructor(view: EditorView) {
              this.decorations = decorations(view);
            }
            update(u: ViewUpdate) {
              if (u.docChanged || u.selectionSet || u.viewportChanged)
                this.decorations = decorations(u.view);
            }
          },
          { decorations: (v) => v.decorations },
        ),
      ),
    );
  },
});
