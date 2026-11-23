import { Facet, StateEffect, StateField, type Extension, Prec } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

/**
 * Leaping to a place on screen, after leap.nvim.
 *
 * `s` and one character label every place after the cursor (`S`: before it) where that
 * character stands, each behind the pair of characters that begins there. The second character
 * leaves the places where that pair stands; if it is one, the cursor goes there, otherwise the
 * label of a place takes it there. Labels are given per pair (the second character tells the
 * pairs apart), so the nearest places have the easiest letters.
 */

/** Letters for the places, the easiest to reach first. */
export const LABELS = 'sfnjklhodweimbuyvrgtaqpcxzSFNJKLHODWEIMBUYVRGTAQPCXZ';

/** A place in a text that is on screen but not part of the note (a figure's caption). */
export interface LeapField {
  text: string;
  element: HTMLElement;
  /** Where its figure stands in the note: what the field counts as being at. */
  from: number;
  to: number;
  /** Puts the cursor at `offset` in the text. */
  edit(offset: number): void;
}

export interface LeapTarget {
  /** In the note; for a place in a field, where its figure ends. */
  pos: number;
  /** The field and the place in its text, for a place that is not in the note. */
  field?: LeapField;
  offset?: number;
  /** The character that follows the first one there (lower case when the search is). */
  second: string;
  label: string;
}

/**
 * Every place in `text` where `first` stands with a character behind it, labelled. Lower-case
 * letters find upper-case ones too (as with vim's smartcase). `offset` is where `text` starts
 * in the note; `dir` 1 takes the places after `cursor`, -1 those before it, 0 both.
 */
export function leapTargets(
  text: string,
  offset: number,
  first: string,
  cursor: number,
  labels = LABELS,
  dir: 1 | -1 | 0 = 0,
): LeapTarget[] {
  return labelTargets(leapCandidates(text, offset, first, cursor, dir), cursor, labels);
}

type Candidate = Omit<LeapTarget, 'label'>;

/** The places of `leapTargets`, without labels. */
export function leapCandidates(
  text: string,
  offset: number,
  first: string,
  cursor: number,
  dir: 1 | -1 | 0 = 0,
): Candidate[] {
  if (first.length !== 1) return [];
  const exact = first !== first.toLowerCase();
  const found: Candidate[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i]!;
    if ((exact ? c : c.toLowerCase()) !== first) continue;
    const second = text[i + 1]!;
    if (second === '\n') continue;
    const pos = offset + i;
    if (pos === cursor || (dir !== 0 && (dir > 0 ? pos < cursor : pos > cursor))) continue;
    found.push({ pos, second });
  }
  return found;
}

/** The same in a field: every place in its text counts as being where its figure ends. */
export function fieldCandidates(field: LeapField, first: string): Candidate[] {
  return leapCandidates(field.text, 0, first, -1).map((c) => ({
    pos: field.to,
    second: c.second,
    field,
    offset: c.pos,
  }));
}

/** Labels per pair (the second character tells the pairs apart), the nearest place first. */
export function labelTargets(found: Candidate[], cursor: number, labels = LABELS): LeapTarget[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of found) {
    // Told apart the way the second character will be typed: lower case finds both.
    const key = c.second.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: LeapTarget[] = [];
  for (const places of groups.values()) {
    places.sort(
      (a, b) =>
        Math.abs(a.pos - cursor) - Math.abs(b.pos - cursor) ||
        a.pos - b.pos ||
        (a.offset ?? 0) - (b.offset ?? 0),
    );
    places.slice(0, labels.length).forEach((c, i) => out.push({ ...c, label: labels[i]! }));
  }
  return out.sort((a, b) => a.pos - b.pos || (a.offset ?? -1) - (b.offset ?? -1));
}

/** The places left once the second character is typed (lower case finds upper case too). */
export function pruneTargets(targets: LeapTarget[], second: string): LeapTarget[] {
  const exact = second !== second.toLowerCase();
  return targets.filter((t) => (exact ? t.second : t.second.toLowerCase()) === second);
}

interface LeapState {
  /** 1: to places after the cursor (further down), -1: to places before it (up). */
  dir: 1 | -1;
  /** How many of the two characters were typed. */
  typed: 0 | 1 | 2;
  targets: LeapTarget[];
  /** Where the cursor was when the leap began: a move of it ends the leap. */
  from: number;
}

const setLeap = StateEffect.define<LeapState | null>();

/** Where the texts outside the note come from (the captions of the figures on screen). */
const leapFields = Facet.define<
  (view: EditorView) => LeapField[],
  (view: EditorView) => LeapField[]
>({
  combine: (all) => (view) => all.flatMap((f) => f(view)),
});

/** The place in an element's text, as a range of one or two characters. */
function rangeIn(element: HTMLElement, offset: number, length: number): Range | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const size = node.textContent?.length ?? 0;
    if (left < size) {
      const range = document.createRange();
      range.setStart(node, left);
      range.setEnd(node, Math.min(size, left + length));
      return range;
    }
    left -= size;
  }
  return undefined;
}

/** The labels of the places in fields: drawn over them, as the fields are not the editor's. */
const fieldLabels = ViewPlugin.fromClass(
  class {
    private drawn: HTMLElement[] = [];
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      const leap = update.state.field(leapField, false);
      if (leap === update.startState.field(leapField, false)) return;
      const targets = leap?.targets.filter((t) => t.field) ?? [];
      // Measured once the editor has drawn what this update changed.
      this.view.requestMeasure({
        read: (view) => {
          const base = view.dom.getBoundingClientRect();
          return targets.flatMap((t) => {
            const box = rangeIn(t.field!.element, t.offset!, 2)?.getBoundingClientRect();
            return box ? [{ label: t.label, x: box.right - base.left, y: box.top - base.top }] : [];
          });
        },
        write: (labels) => {
          this.clear();
          for (const { label, x, y } of labels) {
            const tag = document.createElement('span');
            tag.className = 'pm-vim-leap-label is-over';
            tag.textContent = label;
            tag.style.left = `${x}px`;
            tag.style.top = `${y}px`;
            this.view.dom.append(tag);
            this.drawn.push(tag);
          }
        },
      });
    }
    clear() {
      for (const el of this.drawn) el.remove();
      this.drawn = [];
    }
    destroy() {
      this.clear();
    }
  },
);

class LabelWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: LabelWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    // An element without width: the letter floats over the text and moves nothing.
    const anchor = document.createElement('span');
    anchor.className = 'pm-vim-leap-anchor';
    const tag = document.createElement('span');
    tag.className = 'pm-vim-leap-label';
    tag.textContent = this.label;
    anchor.append(tag);
    return anchor;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const leapField = StateField.define<LeapState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLeap)) return effect.value;
    if (!value) return null;
    // A change to the note ends it, and so does the cursor going elsewhere. (The vim keys
    // set the selection again after every command, to where it already is: that is no move.)
    if (tr.docChanged || tr.state.selection.main.head !== value.from) return null;
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (leap): DecorationSet => {
      if (!leap?.targets.length) return Decoration.none;
      return Decoration.set(
        leap.targets
          .filter((t) => !t.field)
          .flatMap((t) => [
            Decoration.mark({ class: 'pm-vim-leap-match' }).range(t.pos, t.pos + 2),
            // Behind the pair, so both of its characters can be read.
            Decoration.widget({ widget: new LabelWidget(t.label), side: 1 }).range(t.pos + 2),
          ]),
        true,
      );
    }),
    EditorView.editorAttributes.from(field, (leap) => ({
      class: leap ? 'pm-vim-leaping' : '',
    })),
  ],
});

/** Whether a leap is waiting for its characters or its label. */
export const leaping = (view: EditorView): boolean => !!view.state.field(leapField, false);

/**
 * Starts a leap forward (`s`: to a place after the cursor) or backward (`S`: before it). The
 * next keys are its two characters, then (if needed) the label.
 */
export function startLeap(view: EditorView, dir: 1 | -1 = 1): void {
  const from = view.state.selection.main.head;
  view.dispatch({ effects: setLeap.of({ dir, typed: 0, targets: [], from }) });
}

function onKey(view: EditorView, event: KeyboardEvent): boolean {
  const leap = view.state.field(leapField, false);
  if (!leap) return false;
  const stop = () => {
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  const end = () => view.dispatch({ effects: setLeap.of(null) });
  if (event.key === 'Escape' || (event.ctrlKey && event.key === '[')) {
    end();
    return stop();
  }
  if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) {
    // Shift and the like are part of the next key; anything else ends the leap.
    if (!['Shift', 'Alt', 'Control', 'Meta', 'CapsLock', 'Dead'].includes(event.key)) end();
    return stop();
  }
  const go = (target: LeapTarget) => {
    if (!target.field) return goTo(target.pos);
    view.dispatch({ effects: setLeap.of(null) });
    target.field.edit(target.offset ?? 0);
  };
  const goTo = (pos: number) =>
    view.dispatch({
      selection: { anchor: pos },
      effects: [setLeap.of(null), EditorView.scrollIntoView(pos, { y: 'nearest' })],
      userEvent: 'select',
    });
  if (leap.typed === 0) {
    // The first character: every place it stands on screen gets its label.
    const cursor = leap.from;
    const targets = labelTargets(
      [
        ...view.visibleRanges.flatMap(({ from, to }) =>
          leapCandidates(view.state.doc.sliceString(from, to), from, event.key, cursor, leap.dir),
        ),
        // A caption lies under its figure: after the cursor that stands at or above it.
        ...view.state
          .facet(leapFields)(view)
          .filter((f) => (leap.dir > 0 ? cursor <= f.to : cursor > f.to))
          .flatMap((f) => fieldCandidates(f, event.key)),
      ],
      cursor,
    );
    if (!targets.length) end();
    else view.dispatch({ effects: setLeap.of({ ...leap, typed: 1, targets }) });
    return stop();
  }
  if (leap.typed === 1) {
    // The second character: the places where the pair stands stay, with their labels.
    const targets = pruneTargets(leap.targets, event.key);
    if (targets.length === 1) go(targets[0]!);
    else if (!targets.length) end();
    else view.dispatch({ effects: setLeap.of({ ...leap, typed: 2, targets }) });
    return stop();
  }
  // The label of a place.
  const target = leap.targets.find((t) => t.label === event.key);
  if (target) go(target);
  else end();
  return stop();
}

/** Put in front of the vim keys: while a leap is on, the keys are its own. */
export function leapExtension(fields: (view: EditorView) => LeapField[] = () => []): Extension {
  return [
    leapFields.of(fields),
    fieldLabels,
    leapField,
    Prec.highest(EditorView.domEventHandlers({ keydown: (event, view) => onKey(view, event) })),
  ];
}
