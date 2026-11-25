import { syntaxTree } from '@codemirror/language';
import {
  Annotation,
  EditorState,
  Transaction,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  isNoteId,
  revealChanged,
  revealedAt,
  type EditorExtensionContext,
  type MetadataIndexApi,
} from '@pumice/api';

/** Folded `id|` of an ID link while its line is being edited. */
class FoldedIdWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-pm-folded-id';
    span.title = 'Note ID (hidden)';
    span.textContent = '⁝';
    return span;
  }
}
const folded = Decoration.replace({ widget: new FoldedIdWidget() });

export interface IdEditorDeps {
  index: MetadataIndexApi;
  isId(target: string): boolean;
  showIds(): boolean;
  notifyProtected(): void;
}

/**
 * `[[id|Name]]` reads as `[[⁝Name]]` while the cursor is at it (elsewhere the links plugin shows
 * just the name), and the cursor skips the folded ID.
 */
function foldIds(deps: IdEditorDeps, ctx: EditorExtensionContext): Extension {
  const build = (view: EditorView): DecorationSet => {
    if (deps.showIds()) return Decoration.none;
    const source = ctx.sourceMode();
    const out: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node) => {
          if (node.name !== 'WikiLink') return undefined;
          const target = node.node.getChild('WikiLinkTarget');
          const pipe = node.node.getChild('WikiLinkPipe');
          if (!target || !pipe) return false;
          // A link the cursor is not at already shows only the name in live preview.
          if (!source && !revealedAt(view.state, node.from, node.to)) return false;
          const id = view.state.sliceDoc(target.from, target.to).trim();
          if (isNoteId(id) && deps.isId(id)) out.push(folded.range(node.from + 2, pipe.to));
          return false;
        },
      });
    }
    return Decoration.set(out, true);
  };
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly sub: { dispose(): void };
      constructor(readonly view: EditorView) {
        this.decorations = build(view);
        this.sub = deps.index.onDidChange(() => {
          this.decorations = build(this.view);
          this.view.dispatch({});
        });
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          revealChanged(u.startState, u.state) ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        )
          this.decorations = build(u.view);
      }
      destroy() {
        this.sub.dispose();
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (p) =>
        EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
    },
  );
  return plugin;
}

/** Annotate a transaction with this to change the ID line on purpose ("Change note ID"). */
export const allowIdEdit = Annotation.define<boolean>();

/** The frontmatter `id:` line can't be edited by typing (it would silently break ID links). */
function protectIdLine(deps: IdEditorDeps): Extension {
  return EditorState.transactionFilter.of((tr) => {
    // Only user edits: remote (collaboration) and merged disk changes have no user event.
    if (!tr.docChanged || !tr.annotation(Transaction.userEvent) || tr.annotation(allowIdEdit))
      return tr;
    const doc = tr.startState.doc;
    if (!doc.sliceString(0, 3).startsWith('---')) return tr;
    let idLine: { from: number; to: number } | undefined;
    for (let n = 2; n <= Math.min(doc.lines, 200); n++) {
      const l = doc.line(n);
      if (/^(---|\.\.\.)\s*$/.test(l.text)) break;
      if (/^id\s*:/.test(l.text)) idLine = { from: l.from, to: l.to };
    }
    if (!idLine) return tr;
    const { from, to } = idLine;
    let touches = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (fromA > to || toA < from) return;
      const text = inserted.toString();
      // New lines before or after the ID line are fine.
      if (fromA === toA && fromA === to && text.startsWith('\n')) return;
      if (fromA === toA && fromA === from && text.endsWith('\n')) return;
      touches = true;
    });
    if (!touches) return tr;
    deps.notifyProtected();
    return [];
  });
}

export function idEditorExtension(deps: IdEditorDeps, ctx: EditorExtensionContext): Extension {
  return [foldIds(deps, ctx), protectIdLine(deps)];
}
