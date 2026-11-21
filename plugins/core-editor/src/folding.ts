import {
  codeFolding,
  foldEffect,
  foldKeymap,
  foldable,
  foldedRanges,
  syntaxTree,
  unfoldEffect,
} from '@codemirror/language';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { createIcon } from '@pumice/ui';

/**
 * Sections fold at their heading: an arrow beside the heading (shown when the pointer is on
 * the line, and always while the section is folded) hides everything up to the next heading
 * of the same or a higher level.
 */

/** The section a heading line opens, if there is anything in it to fold. */
function sectionAt(state: EditorState, lineFrom: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineFrom);
  return foldable(state, line.from, line.to);
}

function foldedAt(state: EditorState, range: { from: number; to: number }): boolean {
  let folded = false;
  foldedRanges(state).between(range.from, range.to, (from, to) => {
    if (from === range.from && to === range.to) folded = true;
  });
  return folded;
}

class FoldToggle extends WidgetType {
  constructor(private readonly folded: boolean) {
    super();
  }
  override eq(other: FoldToggle): boolean {
    return other.folded === this.folded;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = `cm-pm-fold${this.folded ? ' is-folded' : ''}`;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', this.folded ? 'Unfold section' : 'Fold section');
    el.setAttribute('aria-expanded', String(!this.folded));
    el.title = this.folded ? 'Unfold' : 'Fold';
    el.append(createIcon(this.folded ? 'chevron-right' : 'chevron-down', 14));
    // mousedown: the cursor stays where it is.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const range = sectionAt(view.state, view.posAtDOM(el));
      if (!range) return;
      view.dispatch({
        effects: (foldedAt(view.state, range) ? unfoldEffect : foldEffect).of(range),
      });
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

function toggles(view: EditorView): DecorationSet {
  const { state } = view;
  const found: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (!/^(?:ATXHeading|SetextHeading)\d$/.test(node.name)) return;
        const line = state.doc.lineAt(node.from);
        const range = sectionAt(state, line.from);
        if (range)
          found.push(
            Decoration.widget({ widget: new FoldToggle(foldedAt(state, range)), side: -1 }).range(
              line.from,
            ),
          );
        return false;
      },
    });
  }
  return Decoration.set(found, true);
}

const foldToggles = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = toggles(view);
    }
    update(u: ViewUpdate) {
      const folded = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)),
      );
      if (
        u.docChanged ||
        u.viewportChanged ||
        folded ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      )
        this.decorations = toggles(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export function sectionFolding(): Extension {
  return [
    codeFolding({
      placeholderDOM(view, onclick) {
        const el = document.createElement('span');
        el.className = 'cm-pm-fold-placeholder';
        el.textContent = '…';
        el.title = 'Unfold';
        el.setAttribute('aria-label', 'Folded section: unfold');
        el.addEventListener('click', onclick);
        return el;
      },
    }),
    keymap.of(foldKeymap),
    foldToggles,
  ];
}
