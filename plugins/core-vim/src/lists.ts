import { syntaxTree } from '@codemirror/language';
import { Prec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';

/**
 * Lists in normal mode. The marker of an item (`- `, `1. `, `- [ ] ` with what it is set in
 * by) is drawn as a bullet or a box, and shows its source when the cursor is in it. Going up
 * or down a list at the start of the lines, the cursor would land in the marker of every
 * item and turn each into its source in passing; so j and k put it at the start of the item's
 * text instead. Every other way reaches the marker as in vim (h, b, 0, ^, I, …).
 */

const MARKER = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?/;

/** Where the text of the list item on the line of `pos` starts, if `pos` is before it. */
export function itemTextStart(state: EditorState, pos: number): number | undefined {
  const line = state.doc.lineAt(pos);
  const marker = MARKER.exec(line.text)?.[0];
  // An item with nothing written in it yet has no other place than its marker.
  if (!marker || marker.length >= line.length || pos >= line.from + marker.length) return undefined;
  const indent = /^[ \t]*/.exec(line.text)![0].length;
  let listed = false;
  for (let n = syntaxTree(state).resolveInner(line.from + indent, 1); ;) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return undefined;
    if (n.name === 'BulletList' || n.name === 'OrderedList') listed = true;
    if (!n.parent) break;
    n = n.parent;
  }
  return listed ? line.from + marker.length : undefined;
}

interface VimState {
  insertMode?: boolean;
  visualMode?: boolean;
}

export function listCursor(sourceMode: () => boolean): Extension {
  const lastKey = new WeakMap<EditorView, string>();
  return [
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          lastKey.set(view, event.key);
          return false;
        },
      }),
    ),
    clamp(lastKey, sourceMode),
  ];
}

function clamp(lastKey: WeakMap<EditorView, string>, sourceMode: () => boolean): Extension {
  return EditorView.updateListener.of((update) => {
    const { view } = update;
    const vim = (getCM(view) as unknown as { state?: { vim?: VimState } } | null)?.state?.vim;
    if (!vim) return;
    if (vim.insertMode || vim.visualMode || sourceMode()) return;
    if (!update.selectionSet || update.docChanged) return;
    // Only going up and down: every other way into the marker is meant (h, b, 0, ^, a click).
    // (The key counts for the move it made, not for a click that comes after it.)
    const key = lastKey.get(view) ?? '';
    lastKey.delete(view);
    if (!['j', 'k', 'ArrowUp', 'ArrowDown'].includes(key)) return;
    const sel = update.state.selection.main;
    if (!sel.empty) return;
    const from = update.startState.selection.main.head;
    if (update.startState.doc.lineAt(from).number === update.state.doc.lineAt(sel.head).number)
      return;
    // Coming from a marker, the cursor is in the markers on purpose (ticking one after the
    // other): it stays in them.
    // (The same place in the next marker: the keys go by where things are on screen, and a
    // marker that shows its source is wider than one that is drawn.)
    let to: number | undefined;
    if (itemTextStart(update.startState, from) !== undefined) {
      const old = update.startState.doc.lineAt(from);
      const line = update.state.doc.lineAt(sel.head);
      const end = itemTextStart(update.state, line.from);
      if (end === undefined) return;
      const indent = (text: string) => /^[ \t]*/.exec(text)![0].length;
      const within = Math.max(0, from - old.from - indent(old.text));
      to = Math.min(line.from + indent(line.text) + within, end - 1);
      if (to === sel.head) return;
    } else to = itemTextStart(update.state, sel.head);
    if (to === undefined) return;
    // Not within the update that is going on.
    void Promise.resolve().then(() => {
      const current = view.state.selection.main;
      if (!current.empty || current.head !== sel.head) return;
      view.dispatch({ selection: { anchor: to! }, userEvent: 'select' });
    });
  });
}
