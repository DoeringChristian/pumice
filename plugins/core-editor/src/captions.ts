import { EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { isFigureTarget, mediaIn, type MediaText } from '@pumice/api';

/**
 * The caption of a figure is text of the note, written under the picture where it is read: only
 * what stands around it (`![[a.png|` and `]]{#fig-a}`) is not shown. Here is what keeps that
 * from being broken while it is written; what it looks like is in the live preview.
 */

/** A figure with a place for a caption, in the note. */
export interface CaptionPlace {
  from: number;
  /** Where its caption begins and ends. */
  captionFrom: number;
  captionTo: number;
  to: number;
  /** Absent for a frame block (its caption is a line of it). */
  media?: MediaText;
}

/** Whether a caption is written between the brackets already, or there is a place for one. */
export const hasCaptionPlace = (media: MediaText, line: string): boolean =>
  isFigureTarget(media.target) &&
  (media.spelling === 'image' || /\|$/.test(line.slice(0, media.captionFrom)));

const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)/;

/** The caption line of a frame block, as a place to write in (not one over several lines). */
export function frameCaption(
  state: EditorState,
  block: { from: number; to: number },
): CaptionPlace | undefined {
  const last = state.doc.lineAt(block.to).number;
  for (let n = state.doc.lineAt(block.from).number + 1; n < last; n++) {
    const line = state.doc.line(n);
    const m = /^caption[ \t]*:[ \t]*/.exec(line.text);
    if (!m) continue;
    const value = line.text.slice(m[0].length).trimEnd();
    if (/^[|>]/.test(value)) return undefined;
    const quoted = /^(["'])((?:(?!\1)[^\\])*)\1$/.exec(value);
    if (!quoted && /^["']/.test(value)) return undefined;
    const captionFrom = line.from + m[0].length + (quoted ? 1 : 0);
    return {
      from: block.from,
      captionFrom,
      captionTo: quoted ? captionFrom + quoted[2]!.length : line.to,
      to: block.to,
    };
  }
  return undefined;
}

/** The frame block whose caption line is at `pos`. */
function frameAt(state: EditorState, pos: number): CaptionPlace | undefined {
  const line = state.doc.lineAt(pos);
  if (!/^caption[ \t]*:/.test(line.text)) return undefined;
  for (let n = line.number - 1; n >= Math.max(1, line.number - 200); n--) {
    const open = state.doc.line(n);
    const fence = FENCE.exec(open.text);
    if (!fence) continue;
    if (fence[2] !== 'frame') return undefined;
    for (let k = line.number + 1; k <= Math.min(state.doc.lines, line.number + 200); k++) {
      const close = state.doc.line(k);
      if (close.text.trim().startsWith(fence[1]!))
        return frameCaption(state, { from: open.from, to: close.to });
    }
    return undefined;
  }
  return undefined;
}

/** The figures of the line at `pos` whose caption is text of the note. */
export function captionPlaces(state: EditorState, pos: number): CaptionPlace[] {
  const frame = frameAt(state, pos);
  if (frame) return [frame];
  const line = state.doc.lineAt(pos);
  return mediaIn(line.text)
    .filter((media) => hasCaptionPlace(media, line.text))
    .map((media) => ({
      from: line.from + media.from,
      captionFrom: line.from + media.captionFrom,
      captionTo: line.from + media.captionTo,
      to: line.from + media.to,
      media,
    }));
}

/** The figure whose caption the cursor is in. */
export function captionAt(state: EditorState, pos: number): CaptionPlace | undefined {
  return captionPlaces(state, pos).find((p) => p.captionFrom <= pos && pos <= p.captionTo);
}

/** Puts the cursor into a figure's caption, making a place for one if there is none. */
export function enterCaption(view: EditorView, from: number, at: 'start' | 'end' = 'end'): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const line = state.doc.lineAt(from);
  const media = mediaIn(line.text).find((m) => line.from + m.from === from);
  if (!media || !isFigureTarget(media.target)) return false;
  if (hasCaptionPlace(media, line.text))
    view.dispatch({
      selection: {
        anchor: line.from + (at === 'start' ? media.captionFrom : media.captionTo),
      },
      userEvent: 'select',
    });
  else {
    // In a table cell the bar is written `\|`.
    const bar = /^\s*\|/.test(line.text) ? '\\|' : '|';
    const pos = line.from + media.captionFrom;
    view.dispatch({
      changes: { from: pos, insert: bar },
      selection: { anchor: pos + bar.length },
      userEvent: 'input.caption',
    });
  }
  view.focus();
  return true;
}

/** Whether what is at `pos` is shown as source: then it is text like any other. */
type ShownAsSource = (state: EditorState, from: number, to: number) => boolean;

/**
 * Typing and deleting leave a figure whole. A change that would take a part of what is hidden is
 * not made at all (never widened to the figure); a caption stays one line.
 */
const guard = (shownAsSource: ShownAsSource) =>
  EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (!['input.type', 'input.paste', 'input.drop', 'delete'].some((e) => tr.isUserEvent(e)))
      return tr;
    const { startState: state } = tr;
    let refused = false;
    let lines = false;
    tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      const places = [
        ...captionPlaces(state, from),
        ...(state.doc.lineAt(to).from > from ? captionPlaces(state, to) : []),
      ].filter((p) => !shownAsSource(state, p.from, p.to));
      for (const p of places) {
        // All of it, or nothing of what stands around its caption.
        if (from <= p.from && to >= p.to) continue;
        if ((from < p.captionFrom && to > p.from) || (from < p.to && to > p.captionTo))
          refused = true;
        else if (from >= p.captionFrom && to <= p.captionTo && inserted.lines > 1) lines = true;
      }
    });
    if (refused) return [];
    if (!lines) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((from, to, _fromB, _toB, inserted) =>
      changes.push({ from, to, insert: inserted.toString().replace(/\s*\n+\s*/g, ' ') }),
    );
    const set = state.changes(changes);
    return {
      changes: set,
      selection: { anchor: set.mapPos(changes[changes.length - 1]!.to, 1) },
      scrollIntoView: true,
    };
  });

/** At the ends of a caption nothing more is deleted: what stands beside it is not text. */
const stopAt = (edge: 'captionFrom' | 'captionTo', shown: ShownAsSource) => (view: EditorView) => {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const place = captionAt(view.state, sel.head);
  return !!place && sel.head === place[edge] && !shown(view.state, place.from, place.to);
};

/** Backspace right behind a figure, or Delete right in front of it, takes the figure out. */
const takeOut = (forward: boolean, shown: ShownAsSource) => (view: EditorView) => {
  const sel = view.state.selection.main;
  if (!sel.empty || view.state.readOnly) return false;
  const place = captionPlaces(view.state, sel.head).find(
    (p) => p.media && sel.head === (forward ? p.from : p.to),
  );
  if (!place || shown(view.state, place.from, place.to)) return false;
  view.dispatch({
    changes: { from: place.from, to: place.to },
    userEvent: forward ? 'delete.forward' : 'delete.backward',
  });
  return true;
};

/** To the start or the end of the caption (its line goes on with what is not text). */
const toEdge =
  (edge: 'captionFrom' | 'captionTo', shown: ShownAsSource, extend: boolean) =>
  (view: EditorView) => {
    const sel = view.state.selection.main;
    const place = captionAt(view.state, sel.head);
    if (!place || shown(view.state, place.from, place.to)) return false;
    view.dispatch({
      selection: { anchor: extend ? sel.anchor : place[edge], head: place[edge] },
      userEvent: 'select',
    });
    return true;
  };

/** Out of a caption: behind its figure. */
const leave = (shown: ShownAsSource) => (view: EditorView) => {
  const place = captionAt(view.state, view.state.selection.main.head);
  if (!place || shown(view.state, place.from, place.to)) return false;
  view.dispatch({ selection: EditorSelection.cursor(place.to), userEvent: 'select' });
  return true;
};

export function captionEditing(shownAsSource: ShownAsSource): Extension {
  return [
    guard(shownAsSource),
    Prec.high(
      keymap.of([
        { key: 'Enter', run: leave(shownAsSource), shift: leave(shownAsSource) },
        { key: 'Escape', run: leave(shownAsSource) },
        ...(['Home', 'Mod-ArrowLeft'] as const).map((key) => ({
          key,
          run: toEdge('captionFrom', shownAsSource, false),
          shift: toEdge('captionFrom', shownAsSource, true),
        })),
        ...(['End', 'Mod-ArrowRight'] as const).map((key) => ({
          key,
          run: toEdge('captionTo', shownAsSource, false),
          shift: toEdge('captionTo', shownAsSource, true),
        })),
        { key: 'Backspace', run: stopAt('captionFrom', shownAsSource) },
        { key: 'Delete', run: stopAt('captionTo', shownAsSource) },
        { key: 'Backspace', run: takeOut(false, shownAsSource) },
        { key: 'Delete', run: takeOut(true, shownAsSource) },
      ]),
    ),
    // The first character of an empty caption: there is no text on screen to put it into.
    Prec.highest(
      EditorView.domEventHandlers({
        beforeinput(event, view) {
          if (event.inputType !== 'insertText' || !event.data) return false;
          const sel = view.state.selection.main;
          const place = sel.empty ? captionAt(view.state, sel.head) : undefined;
          if (!place || place.captionFrom !== place.captionTo) return false;
          if (shownAsSource(view.state, place.from, place.to)) return false;
          event.preventDefault();
          view.dispatch({
            changes: { from: sel.head, insert: event.data },
            selection: { anchor: sel.head + event.data.length },
            userEvent: 'input.type',
          });
          return true;
        },
      }),
    ),
    // A bracket in a caption begins a reference: by itself it would end the figure.
    Prec.highest(
      EditorView.inputHandler.of((view, from, to, text) => {
        if (text !== '[' && text !== ']') return false;
        const place = captionAt(view.state, from);
        if (
          !place ||
          place.media?.spelling !== 'wiki' ||
          to > place.captionTo ||
          shownAsSource(view.state, place.from, place.to)
        )
          return false;
        const before = view.state.sliceDoc(place.captionFrom, from);
        const open = /\[\[[^[\]]*$/.test(before);
        if (text === ']') {
          // Over the end of the reference; nothing else.
          if (open && view.state.sliceDoc(to, to + 2) === ']]')
            view.dispatch({ selection: { anchor: to + 2 } });
          return true;
        }
        if (open) return true;
        view.dispatch({
          changes: { from, to, insert: '[[#^]]' },
          selection: { anchor: from + 4 },
          userEvent: 'input.type',
        });
        return true;
      }),
    ),
  ];
}
