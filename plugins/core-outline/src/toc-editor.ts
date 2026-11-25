import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { revealChanged, revealedLines, type EditorExtensionContext } from '@pumice/api';
import { TOC_LINE } from './toc';

/** Draws a table of contents into an element, and keeps it current; the result ends that. */
export type DrawToc = (container: HTMLElement, path: string) => () => void;

class TocLineWidget extends WidgetType {
  private stop: (() => void) | undefined;
  constructor(
    readonly path: string,
    readonly draw: DrawToc,
  ) {
    super();
  }
  override eq(other: TocLineWidget): boolean {
    return other.path === this.path;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-pm-toc-line';
    this.stop = this.draw(el, this.path);
    return el;
  }
  override destroy(): void {
    this.stop?.();
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** A line that says `[TOC]` shows the table of contents, unless the cursor is on it. */
export function tocLines(ctx: EditorExtensionContext, draw: DrawToc): Extension {
  const build = (state: EditorState): DecorationSet => {
    const path = ctx.path();
    if (path === undefined || ctx.sourceMode()) return Decoration.none;
    const active = revealedLines(state);
    const out: Range<Decoration>[] = [];
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      if (line.length > 12 || !TOC_LINE.test(line.text) || active.has(n)) continue;
      // Not in code, where it is just text.
      let code = false;
      for (let node = syntaxTree(state).resolveInner(line.from, 1); ; node = node.parent!) {
        if (/Code|Frontmatter|Math|Comment/.test(node.name)) code = true;
        if (!node.parent) break;
      }
      if (code) continue;
      out.push(
        Decoration.replace({ widget: new TocLineWidget(path, draw), block: true }).range(
          line.from,
          line.to,
        ),
      );
    }
    return Decoration.set(out, true);
  };
  return StateField.define<DecorationSet>({
    create: build,
    update(value, tr) {
      return tr.docChanged ||
        tr.reconfigured ||
        revealChanged(tr.startState, tr.state) ||
        syntaxTree(tr.startState) !== syntaxTree(tr.state)
        ? build(tr.state)
        : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
