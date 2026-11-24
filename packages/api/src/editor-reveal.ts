import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Which lines live preview shows as raw markdown: the lines the selection touches while the
 * editor has focus.
 *
 * While a mouse button is held the revealed lines stay frozen. Revealing syntax changes the
 * layout, and CodeMirror re-reads the pointer position against the new layout on mouse move and
 * mouse up; with the layout frozen, a click or drag lands exactly where the user pointed, and
 * the clicked line opens up once the button is released.
 */
interface RevealState {
  focused: boolean;
  /** Ranges frozen at mousedown, or null when the pointer isn't held. */
  held: ReadonlyArray<{ from: number; to: number }> | null;
}

const setFocused = StateEffect.define<boolean>();
const setHeld = StateEffect.define<boolean>();

const revealField = StateField.define<RevealState>({
  create: () => ({ focused: false, held: null }),
  update(value, tr) {
    let { focused, held } = value;
    if (held && tr.docChanged) {
      held = held.map((r) => ({
        from: tr.changes.mapPos(r.from, -1),
        to: tr.changes.mapPos(r.to, 1),
      }));
    }
    for (const e of tr.effects) {
      if (e.is(setFocused)) focused = e.value;
      else if (e.is(setHeld)) {
        held = e.value
          ? focused
            ? tr.startState.selection.ranges.map((r) => ({ from: r.from, to: r.to }))
            : []
          : null;
      }
    }
    return focused === value.focused && held === value.held ? value : { focused, held };
  },
});

const pointer = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.defaultPrevented) return false;
    if (view.state.field(revealField).held) return false;
    view.dispatch({ effects: setHeld.of(true) });
    const win = view.dom.ownerDocument.defaultView ?? window;
    const release = () => {
      win.removeEventListener('mouseup', release, true);
      win.removeEventListener('dragend', release, true);
      win.removeEventListener('blur', release);
      // After CodeMirror's own mouseup handler has made the final selection.
      setTimeout(() => {
        if (view.state.field(revealField, false)?.held)
          view.dispatch({ effects: setHeld.of(false) });
      });
    };
    win.addEventListener('mouseup', release, true);
    win.addEventListener('dragend', release, true);
    win.addEventListener('blur', release);
    return false;
  },
});

/** Tracks focus and pointer state for {@link revealedLines}; the markdown editor installs it. */
export const revealTracking: Extension = [
  revealField,
  pointer,
  EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
];

/** Line numbers (1-based) whose markdown syntax live preview shows. */
export function revealedLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  const reveal = state.field(revealField, false);
  if (!reveal) return lines;
  const ranges = reveal.held ?? (reveal.focused ? state.selection.ranges : []);
  for (const r of ranges) {
    const first = state.doc.lineAt(Math.min(r.from, state.doc.length)).number;
    const last = state.doc.lineAt(Math.min(r.to, state.doc.length)).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

/**
 * Whether the cursor (or a selection) is in or right at `from`..`to`: what is drawn in place of
 * that piece of source gives way to the source then. Finer than {@link revealedLines}: the rest
 * of the line stays drawn.
 */
export function revealedAt(state: EditorState, from: number, to: number): boolean {
  const reveal = state.field(revealField, false);
  if (!reveal) return false;
  const ranges = reveal.held ?? (reveal.focused ? state.selection.ranges : []);
  return ranges.some((r) => r.from <= to && r.to >= from);
}

/** Whether a transaction may have changed {@link revealedLines}. */
export function revealChanged(startState: EditorState, state: EditorState): boolean {
  const a = startState.field(revealField, false);
  const b = state.field(revealField, false);
  if (a !== b) return true;
  return !b?.held && startState.selection !== state.selection;
}

/**
 * Syntax node names (e.g. `Table`) whose live-preview rendering a plugin provides itself; the
 * editor's built-in block preview skips them.
 */
export const previewBlockOwners = Facet.define<string, ReadonlySet<string>>({
  combine: (names) => new Set(names),
});

/**
 * Counts the changes between reading and writing a note. What is drawn in a note for the one
 * (a caption that can be clicked into, a table whose cells can be typed in) is not what the
 * other needs: a widget keeps the count it was made at, and one made at another is drawn anew.
 */
export const drawnFor = { epoch: 0 };
