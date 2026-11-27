import {
  autocompletion,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import {
  editorCompletions,
  mediaAt,
  figureLabel,
  figureReference,
  itemByNumber,
  labelChange,
  newLabel,
  referableItems,
  renameLabelChanges,
  validLabel,
  type DocumentsApi,
  type MetadataIndexApi,
  type NumberedItem,
  type TextChange,
  type VaultPath,
} from '@pumice/api';
import { editNote } from './links';

/**
 * References to the figures, tables and equations of a note: `[[#^fig-loss]]` or `@fig-loss`.
 * What is referred to gets its label when the reference is made (from the list that opens
 * after `@` or `[[#^`, by its number as in `@fig2`, or with a command), so nobody has to
 * think of one; a label can be renamed, and the references follow.
 */

const cache = new WeakMap<object, NumberedItem[]>();
/** Every figure, table and equation of the note as it is now, numbered or not. */
export function itemsOf(state: EditorState): NumberedItem[] {
  let items = cache.get(state.doc);
  if (!items) cache.set(state.doc, (items = referableItems(state.doc.toString())));
  return items;
}

/** How a reference to a label of this note reads right now ("Figure 2"), if it has it. */
export function localReference(state: EditorState, id: string): string | undefined {
  const item = itemsOf(state).find((i) => i.id === id && i.number > 0);
  return item && figureReference(item);
}

const KIND = { fig: 'Figure', tab: 'Table', eq: 'Equation' } as const;
const cut = (text: string, length = 60) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** A few words of what an item is, where it has no caption: its file, its formula, its head. */
function snippet(state: EditorState, item: NumberedItem): string {
  const line = state.doc.line(Math.min(item.line + 1, state.doc.lines)).text;
  if (item.kind === 'fig') {
    if (item.column === undefined) return 'frame';
    return mediaAt(line, item.column)?.target.split('/').pop() ?? '';
  }
  if (item.kind === 'tab') return cut(line.replace(/\s*\|\s*/g, ' | ').trim());
  const end = state.doc.line(Math.min(item.endLine + 1, state.doc.lines));
  const tex = state.doc
    .sliceString(state.doc.line(item.line + 1).from, end.to)
    // Without the label behind the closing `$$`.
    .replace(/\$\$\s*(?:\^[A-Za-z0-9-]+|\{#[A-Za-z0-9-]+\})\s*$/, '')
    .replace(/\$\$/g, '');
  return cut(tex.replace(/\s+/g, ' ').trim());
}

export interface ItemChoice {
  item: NumberedItem;
  label: string;
  detail: string;
}

/** The items of the note as a list to choose from. */
export function itemChoices(state: EditorState): ItemChoice[] {
  return itemsOf(state).map((item) => {
    const what = snippet(state, item);
    const name = item.number > 0 ? figureLabel(item) : KIND[item.kind];
    return {
      item,
      label: `${name}: ${item.caption ?? what}`,
      detail: [item.caption ? what : '', item.id ?? 'gets a label'].filter(Boolean).join(' · '),
    };
  });
}

const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Whether the letters of `query` come in `text` in that order; fewer gaps score higher. */
function fuzzy(text: string, query: string): number {
  let at = 0;
  let gaps = 0;
  for (const c of query) {
    const found = text.indexOf(c, at);
    if (found < 0) return 0;
    if (found > at) gaps++;
    at = found + 1;
  }
  return 1 / (1 + gaps);
}

/**
 * How well what was typed fits an item (0: not at all): by what it is called ("Figure 2",
 * "fig2", "table1"), by its label, or by words of its caption, loosely ("losscrv" finds
 * "Loss curve").
 */
export function matchScore(choice: ItemChoice, query: string): number {
  const q = squash(query);
  if (!q) return 1;
  const { item } = choice;
  const names =
    item.number > 0
      ? [`${KIND[item.kind]}${item.number}`, `${item.kind}${item.number}`].map(squash)
      : [squash(KIND[item.kind]), item.kind];
  if (names.some((n) => n === q)) return 100;
  if (names.some((n) => n.startsWith(q))) return 50;
  const texts = [item.id ?? '', item.caption ?? '', choice.label, choice.detail].map(squash);
  if (texts.some((t) => t.includes(q))) return 20;
  // Loosely: only for more than a letter or two, which would fit anything.
  if (q.length < 3) return 0;
  return Math.max(...texts.map((t) => fuzzy(t, q))) * 10;
}

/**
 * The label of an item, and the change that gives it one if it has none. `labels` keeps what
 * was given within one edit, so that two references to the same item get the same label.
 */
function labelOf(
  state: EditorState,
  item: NumberedItem,
  labels = new Map<NumberedItem, string>(),
): { id: string; change?: TextChange } {
  if (item.id) return { id: item.id };
  const given = labels.get(item);
  if (given) return { id: given };
  const text = state.doc.toString();
  const id = newLabel(item.kind, text + [...labels.values()].map((l) => `^${l}`).join(' '));
  labels.set(item, id);
  return { id, change: labelChange(text, item, id) };
}

/** Writes a reference to `item` in place of `from..to`, labelling the item if need be. */
export function insertReference(
  view: EditorView,
  item: NumberedItem,
  range: { from: number; to: number },
  form: 'at' | 'link',
): void {
  const { id, change } = labelOf(view.state, item);
  // Nothing behind it: what follows may well be a full stop.
  const text = form === 'at' ? `@${id}` : `[[#^${id}]]`;
  // The label goes behind the item: before or after the reference.
  const before =
    change && change.from < range.from ? change.insert.length - (change.to - change.from) : 0;
  view.dispatch({
    changes: [{ ...range, insert: text }, ...(change ? [change] : [])],
    selection: { anchor: range.from + text.length + before },
    userEvent: 'input.complete',
  });
}

/** The item at a place of the note (an embed there, or a block the place is in). */
export function itemAtPos(state: EditorState, pos: number): NumberedItem | undefined {
  const line = state.doc.lineAt(pos);
  const n = line.number - 1;
  const at = itemsOf(state).filter((i) => i.line <= n && n <= i.endLine);
  return (
    at.find((i) => i.column === pos - line.from) ??
    [...at].reverse().find((i) => i.column === undefined || i.column <= pos - line.from) ??
    at[0]
  );
}

/**
 * What is offered after `@` and after `[[#^`. `note`: the state of the note whose figures,
 * tables and equations are meant (the editor's own, or the note's for a caption's field).
 */
function referenceSource(
  note: (context: CompletionContext) => EditorState,
  insert: (
    view: EditorView,
    item: NumberedItem,
    range: { from: number; to: number },
    form: 'at' | 'link',
  ) => void,
) {
  return (context: CompletionContext): CompletionResult | null => {
    // `@Figure 2`: a number may follow the word after a space.
    const at = context.matchBefore(/@[A-Za-z0-9-]*(?: \d*)?$/);
    const link = at ? null : context.matchBefore(/\[\[#\^[A-Za-z0-9-]*$/);
    const before = at ?? link;
    if (!before) return null;
    if (at) {
      // Not in a mail address.
      const prev = context.state.doc.sliceString(Math.max(0, at.from - 1), at.from);
      if (/[A-Za-z0-9@]/.test(prev)) return null;
    }
    const query = before.text.slice(at ? 1 : 4);
    // With a space only as in "Figure 2", "table 1", "eq 3".
    if (query.includes(' ') && !/^(?:fig(?:ure)?|tab(?:le)?|eq(?:uation)?) \d*$/i.test(query))
      return null;
    const choices = itemChoices(note(context))
      .map((choice) => ({ choice, score: matchScore(choice, query) }))
      .filter((c) => c.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((c) => c.choice);
    if (!choices.length) return null;
    // Swallow the `]]` put there by bracket closing.
    const after = context.state.doc.sliceString(context.pos, context.pos + 2);
    const to = context.pos + (!link ? 0 : after === ']]' ? 2 : after.startsWith(']') ? 1 : 0);
    const options: Completion[] = choices.map((choice, i) => ({
      label: choice.label,
      detail: choice.detail,
      boost: 50 - i / 100,
      apply: (view: EditorView) =>
        insert(view, choice.item, { from: before.from, to }, at ? 'at' : 'link'),
    }));
    return { from: before.from, to: context.pos, options, filter: false };
  };
}

/** The list that opens after `@` and after `[[#^`. */
export function referenceCompletion(): Extension {
  return editorCompletions.of(referenceSource((context) => context.state, insertReference));
}

/**
 * The same list in the field a figure's caption is written in (`note`: the note's editor): a
 * caption can refer to another figure. What is referred to gets its label in the note at once.
 */
export function captionReferences(note: EditorView): Extension {
  const source = referenceSource(
    () => note.state,
    (field, item, range, form) => {
      const { id, change } = labelOf(note.state, item);
      if (change) note.dispatch({ changes: change, userEvent: 'input.reference' });
      const text = form === 'at' ? `@${id}` : `[[#^${id}]]`;
      field.dispatch({
        changes: { ...range, insert: text },
        selection: { anchor: range.from + text.length },
        userEvent: 'input.complete',
      });
    },
  );
  return [
    autocompletion({ override: [source], icons: false, activateOnTyping: true }),
    keymap.of(completionKeymap),
  ];
}

const SHORTHAND =
  /\[\[#\^((?:fig|tab|eq)-?\d+)(?=\]\]|\\?\|)|(?<![A-Za-z0-9@])@((?:fig|tab|eq)-?\d+)(?![A-Za-z0-9-])/gi;

/**
 * A reference by number, `@fig2` or `[[#^fig2]]`, becomes one by label as soon as the cursor
 * has left it: the number is what the figure has right now, the label stays when it changes.
 */
export function numberedReferences(): Extension {
  return ViewPlugin.fromClass(
    class {
      /** Where something was typed that has not been looked at (or is still being typed). */
      dirty: { from: number; to: number } | null = null;

      update(u: ViewUpdate) {
        if (u.docChanged) {
          if (this.dirty)
            this.dirty = {
              from: u.changes.mapPos(this.dirty.from, -1),
              to: u.changes.mapPos(this.dirty.to, 1),
            };
          const typed = u.transactions.some(
            (tr) => tr.docChanged && tr.isUserEvent('input') && !tr.isUserEvent('input.reference'),
          );
          if (typed)
            u.changes.iterChangedRanges((_a, _b, from, to) => {
              this.dirty = this.dirty
                ? { from: Math.min(this.dirty.from, from), to: Math.max(this.dirty.to, to) }
                : { from, to };
            });
        }
        if (this.dirty && (u.docChanged || u.selectionSet || u.focusChanged))
          queueMicrotask(() => this.resolve(u.view));
      }

      resolve(view: EditorView) {
        if (!this.dirty || view.composing || view.state.readOnly) return;
        const { state } = view;
        const from = state.doc.lineAt(Math.min(this.dirty.from, state.doc.length)).from;
        const to = state.doc.lineAt(Math.min(this.dirty.to, state.doc.length)).to;
        const text = state.doc.sliceString(from, to);
        const head = state.selection.main.head;
        const changes: TextChange[] = [];
        const labels = new Map<NumberedItem, string>();
        let waiting = false;
        for (const m of text.matchAll(SHORTHAND)) {
          const name = m[1] ?? m[2]!;
          const start = from + m.index + (m[1] ? 4 : 1);
          const end = start + name.length;
          // Still being written: a link up to its closing brackets.
          const close = m[1] ? text.indexOf(']]', m.index) + 2 + from : end;
          if (view.hasFocus && head >= from + m.index && head <= close) {
            waiting = true;
            continue;
          }
          const item = itemByNumber(itemsOf(state), name);
          if (!item) continue;
          const label = labelOf(state, item, labels);
          changes.push({ from: start, to: end, insert: label.id });
          if (label.change) changes.push(label.change);
        }
        if (!waiting) this.dirty = null;
        if (changes.length) view.dispatch({ changes, userEvent: 'input.reference' });
      }
    },
  );
}

/**
 * A label that is changed by hand where it is given (`{#fig-a}` to `{#fig-setup}`) takes the
 * references to it along, once the cursor has left the line: as one step with the typing.
 */
export function followLabelEdits(): Extension {
  const key = (i: NumberedItem) => `${i.kind}:${i.ordinal}`;
  return ViewPlugin.fromClass(
    class {
      /** What had which label before it was touched. */
      before = new Map<string, string>();

      update(u: ViewUpdate) {
        const typed = u.transactions.some(
          (tr) =>
            tr.docChanged &&
            (tr.isUserEvent('input') || tr.isUserEvent('delete')) &&
            !tr.isUserEvent('input.reference') &&
            !tr.isUserEvent('input.rename') &&
            !tr.isUserEvent('input.complete'),
        );
        if (typed) {
          const was = itemsOf(u.startState);
          const now = itemsOf(u.state);
          // Only while nothing was added or taken away: the same things, in the same order.
          if (was.length === now.length && was.every((w, i) => key(w) === key(now[i]!)))
            was.forEach((w, i) => {
              if (w.id && w.id !== now[i]!.id && !this.before.has(key(w)))
                this.before.set(key(w), w.id);
            });
          else this.before.clear();
        } else if (u.docChanged && this.before.size) {
          // Undo and the like: nothing to follow.
          this.before.clear();
        }
        if (this.before.size && (u.docChanged || u.selectionSet || u.focusChanged))
          queueMicrotask(() => this.resolve(u.view));
      }

      resolve(view: EditorView) {
        if (!this.before.size || view.composing) return;
        const { state } = view;
        const items = itemsOf(state);
        const at = state.doc.lineAt(state.selection.main.head).number - 1;
        const changes: TextChange[] = [];
        for (const [which, old] of [...this.before]) {
          const item = items.find((i) => key(i) === which);
          // Still being written.
          const lines = item
            ? [item.line, item.endLine, item.endLine + 1, item.captionLine ?? item.line]
            : [];
          if (item && view.hasFocus && at >= Math.min(...lines) && at <= Math.max(...lines))
            continue;
          this.before.delete(which);
          // Taken away, as it was again, or one that something else has: no one follows.
          if (!item?.id || item.id === old || !validLabel(item.kind, item.id)) continue;
          if (items.some((i) => i.id === old) || items.filter((i) => i.id === item.id).length > 1)
            continue;
          changes.push(...renameLabelChanges(state.doc.toString(), old, item.id));
        }
        if (changes.length) view.dispatch({ changes, userEvent: 'input.rename' });
      }
    },
  );
}

/**
 * Renames a label: in the note that is open (one step to undo), and in the links other notes
 * have to it. Returns how many other notes were changed.
 */
export async function renameLabel(
  view: EditorView,
  path: VaultPath,
  old: string,
  id: string,
  deps: { index: MetadataIndexApi; documents: DocumentsApi },
): Promise<number> {
  const note = view.state.doc.toString();
  const changes = renameLabelChanges(note, old, id);
  // Links that name the note itself, `[[Note#fig-a]]` (the index may be behind what is typed).
  for (const m of note.matchAll(/\[\[([^[\]|#\n]+)#\^?([^[\]|#\n\\]+)(?=\]\]|\\?\|)/g)) {
    if (m[2] !== old || deps.index.resolve(m[1]!, path)?.file.path !== path) continue;
    const to = m.index + m[0].length;
    changes.push({ from: to - old.length, to, insert: id });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input.rename' });
  let others = 0;
  for (const file of deps.index.files()) {
    if (file.path === path) continue;
    const links = deps.index
      .outgoing(file.path)
      .filter((r) => r.target === path && r.link.subpath?.replace(/^\^/, '') === old);
    if (!links.length) continue;
    const ok = await editNote(deps.documents, file.path, (text) =>
      links.flatMap(({ link }) => {
        const at = text.slice(link.from, link.to).indexOf(`#${link.subpath!}`);
        if (at < 0) return [];
        const to = link.from + at + 1 + link.subpath!.length;
        return [{ from: to - old.length, to, insert: id }];
      }),
    );
    if (ok) others++;
  }
  return others;
}
