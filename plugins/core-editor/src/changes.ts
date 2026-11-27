/**
 * Changes to a note that were not typed here: an assistant's edits, a file changed by another
 * program, a collaborator's paste. They arrive at once, so the editor marks them: they flash in
 * their author's colour, with the author's name where the change ends, or ("keep until
 * reviewed") stay marked until they are kept or undone.
 *
 * The tracker watches every open document (an assistant also edits notes that are not shown);
 * the editor shows what it reports. Who made a change comes from the transaction (this app's
 * assistant, the file on disk) or, for a change from another client, from that client's
 * presence (`AuthorPresence`).
 */
import { StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import {
  AuthoredChange,
  Emitter,
  ORIGIN_EXTERNAL_FILE,
  type AuthorPresence,
  type ChangeAuthor,
  type DocumentsApi,
  type Disposable,
  type VaultPath,
} from '@pumice/api';
import { ySyncAnnotation } from 'y-codemirror.next';
import * as Y from 'yjs';

/** How long a change stays lit when it is not kept for review. */
export const FLASH_MS = 2600;
/** A person's change is marked from this size on (typing is shown by their cursor). */
const PERSON_MIN = 20;
/** Parts of one change closer than this (on one line) are shown as one. */
const JOIN_GAP = 3;
const CONTEXT = 32;
const MAX_KEPT = 200;

/** One place a change touched, in the text after it. */
export interface Hunk {
  from: number;
  to: number;
  /** The text it replaced. */
  removed: string;
}

export interface TrackedChange {
  id: number;
  /** The changes made in one step share it. */
  batch: number;
  author: ChangeAuthor;
  /** Kept marked until kept or undone (else it only flashes). */
  review: boolean;
  /** When it was made (ms). */
  at: number;
  from: number;
  to: number;
  inserted: string;
  removed: string;
  /** The text right before it, to find it again in a document opened anew. */
  prefix: string;
}

interface Kept extends TrackedChange {
  doc?: Y.Doc;
  start?: Y.RelativePosition;
  end?: Y.RelativePosition;
}

interface Detected {
  author: ChangeAuthor;
  /** May be kept for review (assistants and programs, not people). */
  reviewable: boolean;
  /** Marked whatever its size. */
  always: boolean;
}

type Awareness = { getStates(): Map<number, AuthorPresence>; clientID: number };

/** Who made the change of transaction `tr`, if it is one to mark. */
export function detectAuthor(tr: Y.Transaction, awareness?: unknown): Detected | undefined {
  if (tr.origin instanceof AuthoredChange)
    return {
      author: tr.origin.author,
      reviewable: tr.origin.author.kind !== 'person',
      always: tr.origin.author.kind !== 'person',
    };
  if (tr.origin === ORIGIN_EXTERNAL_FILE)
    return {
      author: { kind: 'file', name: 'Changed on disk' },
      reviewable: true,
      always: true,
    };
  if (tr.local) return undefined;
  // From another client: the clients whose text this added. (A deletion records no author in
  // Yjs: one alone is shown without a name.)
  const states = (awareness as Awareness | undefined)?.getStates();
  for (const [client, clock] of tr.afterState) {
    if (client === tr.doc.clientID || clock <= (tr.beforeState.get(client) ?? 0)) continue;
    // An assistant working through another person's app edits as a client of its own.
    for (const other of states?.values() ?? []) {
      const agent = other.agents?.find((a) => a.client === client);
      if (agent)
        return {
          author: { kind: 'agent', name: agent.name, color: agent.color },
          reviewable: true,
          always: true,
        };
    }
    const state = states?.get(client);
    if (state?.user) {
      const kind = state.user.kind ?? 'person';
      return {
        author: { kind, name: state.user.name, color: state.user.color },
        reviewable: kind !== 'person',
        always: kind !== 'person',
      };
    }
  }
  // Someone no longer here (changes made while away), or deletions only.
  return { author: { kind: 'file', name: '' }, reviewable: false, always: false };
}

interface ItemLike {
  right: ItemLike | null;
  deleted: boolean;
  countable: boolean;
  length: number;
  content: { str?: unknown };
}

/** How many characters `event` inserted and removed. */
export function changedSize(event: Y.YTextEvent): number {
  let n = 0;
  for (const d of event.delta) {
    if (typeof d.insert === 'string') n += d.insert.length;
    else if (d.insert) n += 1;
    if (d.delete) n += d.delete;
  }
  return n;
}

/** The places `event` changed in `ytext`, with the text each replaced. */
export function hunksOf(event: Y.YTextEvent, ytext: Y.Text, text = ytext.toString()): Hunk[] {
  const hunks: Hunk[] = [];
  let pos = 0;
  const at = (p: number) => {
    const last = hunks[hunks.length - 1];
    if (last && last.to === p) return last;
    const hunk = { from: p, to: p, removed: '' };
    hunks.push(hunk);
    return hunk;
  };
  const start = (ytext as unknown as { _start: ItemLike | null })._start;
  for (let item = start; item; item = item.right) {
    if (!item.countable) continue;
    const added = event.adds(item as never);
    const deleted = event.deletes(item as never);
    if (added && deleted) continue;
    const str = typeof item.content.str === 'string' ? item.content.str : '￼'.repeat(item.length);
    if (deleted) at(pos).removed += str;
    else if (item.deleted) continue;
    else if (added) {
      at(pos).to += item.length;
      pos += item.length;
    } else pos += item.length;
  }
  // Whole words, not the parts of them a character diff found.
  const tidied: Hunk[] = [];
  hunks.forEach((h, i) => {
    const min = tidied[tidied.length - 1]?.to ?? 0;
    const max = hunks[i + 1]?.from ?? text.length;
    tidied.push(wholeWords(h, text, min, max));
  });
  // Parts close together on one line read as one change.
  const joined: Hunk[] = [];
  for (const h of tidied) {
    const last = joined[joined.length - 1];
    const gap = last ? text.slice(last.to, h.from) : '';
    if (last && h.from - last.to <= JOIN_GAP && !gap.includes('\n')) {
      last.removed += gap + h.removed;
      last.to = h.to;
    } else joined.push({ ...h });
  }
  return joined;
}

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/**
 * `h` moved or widened to whole words, within `min`…`max` of `text`. An insertion or deletion
 * can slide where the text around it repeats its ends ("the cat" → "the big cat" is "big " after
 * "the " or " big" after "the"); it goes where it begins and ends at word boundaries. A
 * replacement inside words is widened to them ("colour" → "color", not "u" removed).
 */
export function wholeWords(h: Hunk, text: string, min = 0, max = text.length): Hunk {
  const boundary = (before: string | undefined, after: string | undefined) =>
    !isWord(before) || !isWord(after);
  if (h.from === h.to || !h.removed) {
    // The change as a string that slides: what was inserted, or what was removed.
    const deletion = h.from === h.to;
    const span = (from: number, change: string) =>
      deletion
        ? { from, to: from, removed: change }
        : { from, to: from + change.length, removed: '' };
    let from = h.from;
    let change = deletion ? h.removed : text.slice(h.from, h.to);
    if (change) {
      // As far left as it goes, then each place to the right, scored.
      const len = change.length;
      while (from > min && text[from - 1] === change[len - 1]) {
        change = text[from - 1] + change.slice(0, -1);
        from--;
        if (!deletion) change = text.slice(from, from + len);
      }
      let best = { from, change, score: -1, words: false };
      for (;;) {
        const before = text[from - 1];
        const after = deletion ? text[from] : text[from + len];
        // Whole lines first (a section added keeps off the next one's `## `), then whole words.
        const score =
          (before === undefined || before === '\n' ? 4 : 0) +
          (change[len - 1] === '\n' ? 4 : 0) +
          (boundary(before, change[0]) ? 2 : 0) +
          (boundary(change[len - 1], after) ? 2 : 0) +
          (isWord(change[0]) ? 1 : 0) +
          (change[0] === '\n' ? 0 : 1);
        const words = boundary(before, change[0]) && boundary(change[len - 1], after);
        if (score > best.score) best = { from, change, score, words };
        const next = deletion ? text[from] : text[from + len];
        if (next === undefined || next !== change[0] || from + (deletion ? 0 : len) >= max) break;
        change = change.slice(1) + next;
        from++;
      }
      h = span(best.from, best.change);
      if (best.words) return h;
    }
  }
  // Widened to the words it touches.
  let from = h.from;
  let to = h.to;
  const first = h.to > h.from ? text[h.from] : h.removed[0];
  const last = h.to > h.from ? text[h.to - 1] : h.removed[h.removed.length - 1];
  if (isWord(first)) while (from > min && isWord(text[from - 1])) from--;
  if (isWord(last)) while (to < max && isWord(text[to])) to++;
  if (from === h.from && to === h.to) return h;
  return { from, to, removed: text.slice(from, h.from) + h.removed + text.slice(h.to, to) };
}

/** Where a change kept from a document opened before is in `text` now. */
function relocate(c: Kept, text: string): { from: number; to: number } | undefined {
  if (
    text.slice(c.from, c.to) === c.inserted &&
    text.slice(c.from - c.prefix.length, c.from) === c.prefix
  )
    return { from: c.from, to: c.to };
  const once = (needle: string, offset: number) => {
    const i = needle ? text.indexOf(needle) : -1;
    if (i < 0 || text.indexOf(needle, i + 1) >= 0) return undefined;
    return { from: i + offset, to: i + offset + c.inserted.length };
  };
  return (
    (c.prefix.length >= 8 || c.inserted.length >= 8
      ? once(c.prefix + c.inserted, c.prefix.length)
      : undefined) ?? (c.inserted.length >= 12 ? once(c.inserted, 0) : undefined)
  );
}

/** Watches the open documents and keeps the changes to review, per note. */
export class ChangeTracker implements Disposable {
  private readonly kept = new Map<VaultPath, Kept[]>();
  private readonly added = new Emitter<{ doc: Y.Doc; changes: TrackedChange[] }>();
  private readonly changed = new Emitter<VaultPath>();
  /** Changes made in an open document, as they happen (before its editor shows them). */
  readonly onDidAdd = this.added.event;
  /** Changes to review were added or removed for a note. */
  readonly onDidChangeKept = this.changed.event;
  private readonly subscriptions: Disposable[] = [];
  private ids = 0;
  private batches = 0;
  /** Stops following an open document. */
  private readonly watching = new Set<() => void>();

  constructor(
    documents: Pick<DocumentsApi, 'onDidOpen'>,
    private readonly review: () => boolean,
  ) {
    this.subscriptions.push(
      documents.onDidOpen((opened) => {
        if (opened.codec.id !== 'markdown') return;
        this.watch(
          opened.doc,
          () => opened.path,
          () => opened.awareness,
          () => opened.synced !== false,
        );
      }),
    );
  }

  /** Follows changes of `doc` (exported for tests). */
  watch(
    doc: Y.Doc,
    path: () => VaultPath,
    awareness: () => unknown,
    /** Whether the document has its first state (see `DocumentAttachment.synced`). */
    synced: () => boolean = () => true,
  ): void {
    const ytext = doc.getText('content');
    let detected: Detected | undefined;
    const before = (tr: Y.Transaction) => {
      detected = tr.changed.has(ytext as never) ? detectAuthor(tr, awareness()) : undefined;
    };
    const after = () => (detected = undefined);
    const observe = (event: Y.YTextEvent) => {
      const found = detected;
      if (!found) return;
      // Small steps of people are typing: decided before anything costly, on what changed.
      if (!found.always && changedSize(event) < PERSON_MIN) return;
      const text = ytext.toString();
      const hunks = hunksOf(event, ytext, text);
      if (!hunks.length) return;
      // A shared note's first state from the server is the note, not a change to it.
      if (!event.transaction.local && !synced()) return;
      const review = found.reviewable && this.review();
      const batch = ++this.batches;
      const at = Date.now();
      const changes: TrackedChange[] = hunks.map((h) => ({
        id: ++this.ids,
        batch,
        author: found.author,
        review,
        at,
        from: h.from,
        to: h.to,
        inserted: text.slice(h.from, h.to),
        removed: h.removed,
        prefix: text.slice(Math.max(0, h.from - CONTEXT), h.from),
      }));
      if (review) {
        const p = path();
        const list = this.kept.get(p) ?? [];
        for (const c of changes)
          list.push({
            ...c,
            doc,
            start: Y.createRelativePositionFromTypeIndex(ytext, c.from, 0),
            end: Y.createRelativePositionFromTypeIndex(ytext, c.to, -1),
          });
        this.kept.set(p, list.slice(-MAX_KEPT));
        this.changed.fire(p);
      }
      this.added.fire({ doc, changes });
    };
    doc.on('beforeObserverCalls', before);
    doc.on('afterTransaction', after);
    ytext.observe(observe);
    const stop = () => {
      doc.off('beforeObserverCalls', before);
      doc.off('afterTransaction', after);
      ytext.unobserve(observe);
      this.watching.delete(stop);
    };
    this.watching.add(stop);
    doc.once('destroy', stop);
  }

  /** The changes of `path` to review, where they are in `doc` now (lost ones are dropped). */
  list(path: VaultPath, doc: Y.Doc): TrackedChange[] {
    const list = this.kept.get(path);
    if (!list?.length) return [];
    const ytext = doc.getText('content');
    let text: string | undefined;
    const found: TrackedChange[] = [];
    const left: Kept[] = [];
    for (const c of list) {
      let place: { from: number; to: number } | undefined;
      if (c.doc === doc && c.start && c.end) {
        const from = Y.createAbsolutePositionFromRelativePosition(c.start, doc)?.index;
        const to = Y.createAbsolutePositionFromRelativePosition(c.end, doc)?.index;
        if (from !== undefined && to !== undefined && (to > from || !c.inserted))
          place = { from, to: Math.max(from, to) };
      } else {
        text ??= ytext.toString();
        place = relocate(c, text);
        if (place) {
          c.doc = doc;
          c.start = Y.createRelativePositionFromTypeIndex(ytext, place.from, 0);
          c.end = Y.createRelativePositionFromTypeIndex(ytext, place.to, -1);
        }
      }
      if (!place) continue;
      text ??= ytext.toString();
      c.from = place.from;
      c.to = place.to;
      // (`inserted` stays what the change left: undoing it checks the text against it.)
      c.prefix = text.slice(Math.max(0, place.from - CONTEXT), place.from);
      left.push(c);
      const { doc: _d, start: _s, end: _e, ...change } = c;
      found.push(change);
    }
    if (left.length !== list.length) this.kept.set(path, left);
    return found;
  }

  /** Done with these changes (kept or undone). */
  remove(path: VaultPath, ids: Iterable<number>): void {
    const gone = new Set(ids);
    const list = this.kept.get(path);
    if (!list) return;
    const left = list.filter((c) => !gone.has(c.id));
    if (left.length === list.length) return;
    if (left.length) this.kept.set(path, left);
    else this.kept.delete(path);
    this.changed.fire(path);
  }

  /** The note was renamed: its changes go along. */
  rename(from: VaultPath, to: VaultPath): void {
    const list = this.kept.get(from);
    if (!list) return;
    this.kept.delete(from);
    this.kept.set(to, list);
  }

  /** Notes with changes to review. */
  paths(): VaultPath[] {
    return [...this.kept.keys()];
  }

  dispose(): void {
    for (const stop of [...this.watching]) stop();
    for (const s of this.subscriptions) s.dispose();
    this.added.dispose();
    this.changed.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// In the editor.

interface Mark extends TrackedChange {}

const addMarks = StateEffect.define<Mark[]>();
const dropMarks = StateEffect.define<(m: Mark) => boolean>();

function mapMark(m: Mark, tr: Transaction): Mark | undefined {
  if (m.to === m.from) {
    const at = tr.changes.mapPos(m.from, -1);
    return { ...m, from: at, to: at };
  }
  const from = tr.changes.mapPos(m.from, 1);
  const to = tr.changes.mapPos(m.to, -1);
  // Its text is gone.
  if (to <= from) return undefined;
  return { ...m, from, to };
}

const NEUTRAL = 'var(--pm-change-neutral)';
const colorOf = (a: ChangeAuthor) => a.color ?? NEUTRAL;
/** What a change's author is called where it is shown. */
export function authorLabel(a: ChangeAuthor): string {
  if (a.name) return a.name;
  return a.kind === 'file' ? 'Changed elsewhere' : 'Someone';
}

interface ChangeActions {
  keep(ids: readonly number[]): void;
  undo(ids: readonly number[]): void;
}

/**
 * The caret and name where a step of changes ends; while they are reviewed, with "keep" and
 * "undo" for the step, or for the one change the cursor is in.
 */
class AuthorWidget extends WidgetType {
  constructor(
    readonly ids: readonly number[],
    readonly author: ChangeAuthor,
    readonly review: boolean,
    readonly elapsed: number,
    readonly actions: ChangeActions,
    /** The cursor is in the change: its name and buttons show (else a dot, until hovered). */
    readonly active: boolean,
  ) {
    super();
  }
  override eq(other: AuthorWidget): boolean {
    return (
      other.ids.join() === this.ids.join() &&
      other.active === this.active &&
      other.review === this.review &&
      (this.review || Math.abs(other.elapsed - this.elapsed) < 1)
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `pm-change-caret${this.review ? ' pm-change-caret-review' : ''}${this.active ? ' pm-change-active' : ''}`;
    el.style.setProperty('--pm-change-color', colorOf(this.author));
    if (!this.review) el.style.animationDelay = `-${this.elapsed}ms`;
    const tag = document.createElement('span');
    tag.className = 'pm-change-tag';
    if (!this.review) tag.style.animationDelay = `-${this.elapsed}ms`;
    const name = document.createElement('span');
    name.textContent = authorLabel(this.author);
    tag.append(name);
    if (this.review) {
      const button = (label: string, title: string, run: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          run();
        });
        return b;
      };
      const what = this.ids.length === 1 ? 'this change' : `these ${this.ids.length} changes`;
      tag.append(
        button('Keep', `Keep ${what}`, () => this.actions.keep(this.ids)),
        button('Undo', `Undo ${what}`, () => this.actions.undo(this.ids)),
      );
    }
    el.append(tag);
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Where text was taken out. */
class RemovedWidget extends WidgetType {
  constructor(
    readonly mark: Mark,
    readonly elapsed: number,
  ) {
    super();
  }
  override eq(other: RemovedWidget): boolean {
    return (
      other.mark.id === this.mark.id &&
      other.mark.review === this.mark.review &&
      (this.mark.review || Math.abs(other.elapsed - this.elapsed) < 1)
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `pm-change-removed${this.mark.review ? ' pm-change-review' : ' pm-change-flash'}`;
    el.style.setProperty('--pm-change-color', colorOf(this.mark.author));
    if (!this.mark.review) el.style.animationDelay = `-${this.elapsed}ms`;
    const shown =
      this.mark.removed.length > 200 ? `${this.mark.removed.slice(0, 200)}…` : this.mark.removed;
    el.title = `${authorLabel(this.mark.author)} removed: ${shown}`;
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function decorate(marks: readonly Mark[], actions: ChangeActions, head: number): DecorationSet {
  const now = Date.now();
  // The change to review the cursor is in: it gets its own "keep" and "undo".
  const at = marks.find((m) => m.review && m.from <= head && head <= m.to);
  const ranges = [];
  const lastOfBatch = new Map<number, Mark>();
  for (const m of marks) {
    const elapsed = m.review ? 0 : Math.max(0, now - m.at);
    if (m.to > m.from) {
      const removed = m.removed
        ? ` (replacing “${m.removed.length > 120 ? `${m.removed.slice(0, 120)}…` : m.removed}”)`
        : '';
      ranges.push(
        Decoration.mark({
          class: `pm-change ${m.review ? 'pm-change-review' : 'pm-change-flash'}`,
          attributes: {
            style: `--pm-change-color: ${colorOf(m.author)};${m.review ? '' : ` animation-delay: -${elapsed}ms`}`,
            title: `${authorLabel(m.author)}${removed}`,
          },
        }).range(m.from, m.to),
      );
    } else {
      ranges.push(
        Decoration.widget({ widget: new RemovedWidget(m, elapsed), side: -1 }).range(m.from),
      );
    }
    const last = lastOfBatch.get(m.batch);
    if (!last || m.to >= last.to) lastOfBatch.set(m.batch, m);
  }
  for (const m of lastOfBatch.values()) {
    const elapsed = m.review ? 0 : Math.max(0, now - m.at);
    const one = at?.batch === m.batch;
    const target = one ? at : m;
    const ids = one ? [at.id] : marks.filter((o) => o.batch === m.batch).map((o) => o.id);
    // At the end of its text, not after the empty lines it ends with.
    const trailing = target.inserted.length - target.inserted.trimEnd().length;
    const end = Math.max(target.from, target.to - trailing);
    ranges.push(
      Decoration.widget({
        widget: new AuthorWidget(ids, m.author, m.review, elapsed, actions, one),
        side: 1,
      }).range(end),
    );
  }
  return Decoration.set(ranges, true);
}

export interface ChangeMarksOptions {
  tracker: ChangeTracker;
  doc: Y.Doc;
  path: () => VaultPath;
  /** Says why something could not be done. */
  notify?: (message: string) => void;
}

/**
 * The marks that can be undone: their text is still what the change left (nothing written into
 * it since, by anyone), and they do not overlap one another.
 */
export function undoable(
  marks: readonly TrackedChange[],
  text: (from: number, to: number) => string,
): { ok: TrackedChange[]; changed: TrackedChange[] } {
  const ok: TrackedChange[] = [];
  const changed: TrackedChange[] = [];
  for (const m of [...marks].sort((a, b) => a.from - b.from)) {
    const last = ok[ok.length - 1];
    if (text(m.from, m.to) !== m.inserted || (last && last.to > m.from)) changed.push(m);
    else ok.push(m);
  }
  return { ok, changed };
}

/** Shows the tracker's changes of one document in its editor. */
export function changeMarks(opts: ChangeMarksOptions): Extension {
  const { tracker, doc } = opts;
  /** Changes made in the document, waiting for the editor transaction that brings them. */
  let inbox: Mark[] = [];
  let view: EditorView | undefined;

  const marksOf = (state: { field(f: typeof field): Mark[] }) => state.field(field);
  const marksWith = (ids: readonly number[]) => {
    const wanted = new Set(ids);
    return view ? marksOf(view.state).filter((m) => wanted.has(m.id)) : [];
  };
  const actions: ChangeActions = {
    keep(ids) {
      const marks = marksWith(ids);
      if (!view || !marks.length) return;
      tracker.remove(opts.path(), ids);
      view.dispatch({ effects: dropMarks.of((m) => ids.includes(m.id)) });
    },
    undo(ids) {
      const marks = marksWith(ids);
      if (!view || !marks.length) return;
      const doc = view.state.doc;
      // Text written into a change since would be lost with it: such a change stays marked.
      const { ok, changed } = undoable(marks, (from, to) => doc.sliceString(from, to));
      if (changed.length)
        opts.notify?.(
          changed.length === 1
            ? 'This change was edited since, so it is not undone. Change it back by hand, or keep it.'
            : `${changed.length} of these changes were edited since, so they are not undone.`,
        );
      if (!ok.length) return;
      const done = ok.map((m) => m.id);
      tracker.remove(opts.path(), done);
      view.dispatch({
        changes: ok.map((m) => ({ from: m.from, to: m.to, insert: m.removed })),
        effects: dropMarks.of((m) => done.includes(m.id)),
        userEvent: 'input.undo-change',
      });
    },
  };

  const field = StateField.define<Mark[]>({
    create: () => tracker.list(opts.path(), doc).map((c) => ({ ...c, at: 0 })),
    update(marks, tr) {
      let next = tr.docChanged ? marks.flatMap((m) => mapMark(m, tr) ?? []) : marks;
      if (tr.docChanged && inbox.length && tr.annotation(ySyncAnnotation) !== undefined) {
        next = [...next, ...inbox.filter((m) => m.to <= tr.newDoc.length)];
        inbox = [];
      }
      for (const e of tr.effects) {
        if (e.is(addMarks)) next = [...next, ...e.value];
        else if (e.is(dropMarks)) next = next.filter((m) => !e.value(m));
      }
      return next;
    },
    provide: (f) =>
      EditorView.decorations.compute([f, 'selection'], (state) =>
        decorate(state.field(f), actions, state.selection.main.head),
      ),
  });

  const plugin = ViewPlugin.define((v) => {
    view = v;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lost = new Set<number>();
    const schedule = () => {
      clearTimeout(timer);
      const flashing = marksOf(v.state).filter((m) => !m.review);
      if (!flashing.length) return;
      const due = Math.min(...flashing.map((m) => m.at + FLASH_MS)) - Date.now();
      timer = setTimeout(
        () => {
          const now = Date.now();
          v.dispatch({ effects: dropMarks.of((m) => !m.review && now - m.at >= FLASH_MS - 20) });
        },
        Math.max(16, due),
      );
    };
    const added = tracker.onDidAdd((e) => {
      if (e.doc !== doc) return;
      inbox.push(...e.changes);
      // Not followed by an editor transaction (nothing to show): forget them.
      queueMicrotask(() => (inbox = []));
    });
    return {
      update(u) {
        if (u.docChanged || u.transactions.some((t) => t.effects.length)) schedule();
        // Changes to review whose text was removed by hand are done with.
        if (u.docChanged) {
          const before = new Set(
            marksOf(u.startState)
              .filter((m) => m.review)
              .map((m) => m.id),
          );
          for (const m of marksOf(u.state)) before.delete(m.id);
          for (const id of before) lost.add(id);
          if (lost.size) {
            tracker.remove(opts.path(), lost);
            lost.clear();
          }
        }
      },
      destroy() {
        clearTimeout(timer);
        added.dispose();
        if (view === v) view = undefined;
      },
    };
  });

  return [field, plugin, changesOverview(field, actions)];
}

// ---------------------------------------------------------------------------------------------
// Beside the editor: marks at the edge for changes out of sight, and a bar for what is to review
// or where an unseen change went.

function scrollParent(el: HTMLElement): HTMLElement | undefined {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return undefined;
}

function changesOverview(field: StateField<Mark[]>, actions: ChangeActions): Extension {
  return ViewPlugin.define((view) => {
    const host = (view.dom.closest('.pm-markdown-view') as HTMLElement | null) ?? view.dom;
    const ticks = document.createElement('div');
    ticks.className = 'pm-change-ticks';
    ticks.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('div');
    bar.className = 'pm-change-bar';
    bar.hidden = true;
    host.append(ticks, bar);
    /** An unseen step of changes, pointed at in the bar for a while (they flash again when shown). */
    let notice: { marks: Mark[]; partly: boolean; until: number } | undefined;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    let next = 0;
    let frame = 0;

    const reveal = (m: Mark) => {
      view.dispatch({
        selection: { anchor: m.to },
        effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
      });
    };
    /** Whether the place is in sight in the scrolled page. */
    const inSight = (pos: number) => {
      const scroller = scrollParent(view.dom) ?? view.scrollDOM;
      const box = scroller.getBoundingClientRect();
      const y = view.documentTop + view.lineBlockAt(pos).top;
      return y >= box.top && y <= box.bottom - 20;
    };

    const drawTicks = () => {
      const marks = view.state.field(field);
      const scroller = scrollParent(view.dom) ?? view.scrollDOM;
      const box = scroller.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      ticks.style.top = `${box.top - hostBox.top}px`;
      ticks.style.height = `${box.height}px`;
      const total = scroller.scrollHeight;
      const offset = view.documentTop - box.top + scroller.scrollTop;
      ticks.replaceChildren(
        ...marks.map((m) => {
          const t = document.createElement('div');
          t.className = `pm-change-tick ${m.review ? 'pm-change-review' : 'pm-change-flash'}`;
          t.style.setProperty('--pm-change-color', colorOf(m.author));
          if (!m.review) t.style.animationDelay = `-${Math.max(0, Date.now() - m.at)}ms`;
          const y = (offset + view.lineBlockAt(m.from).top) / Math.max(1, total);
          t.style.top = `${Math.min(99.5, Math.max(0, y * 100))}%`;
          return t;
        }),
      );
    };

    const drawBar = () => {
      const marks = view.state.field(field);
      const review = marks.filter((m) => m.review);
      const button = (label: string, run: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', run);
        return b;
      };
      if (review.length) {
        const names = [...new Set(review.map((m) => authorLabel(m.author)))];
        const text = document.createElement('span');
        text.textContent = `${names.join(', ')}: ${review.length === 1 ? '1 change' : `${review.length} changes`} to review`;
        const ordered = [...review].sort((a, b) => a.from - b.from);
        bar.replaceChildren(
          text,
          button('Next', () => {
            const m = ordered[next++ % ordered.length];
            if (m) reveal(m);
          }),
          button('Keep all', () => actions.keep(review.map((m) => m.id))),
          button('Undo all', () => actions.undo(review.map((m) => m.id))),
        );
        bar.hidden = false;
        return;
      }
      const shown = notice && Date.now() < notice.until ? notice.marks : [];
      if (!shown.length) {
        bar.hidden = true;
        return;
      }
      const first = [...shown].sort((a, b) => a.from - b.from)[0]!;
      const up = view.documentTop + view.lineBlockAt(first.from).top < 0;
      const text = document.createElement('span');
      const places = shown.length === 1 ? 'a place' : `${shown.length} places`;
      text.textContent = `${authorLabel(first.author)} changed ${notice!.partly ? `${places} out of sight too` : places}`;
      bar.replaceChildren(
        text,
        button(up ? 'Show ↑' : 'Show ↓', () => {
          notice = undefined;
          bar.hidden = true;
          const now = Date.now();
          view.dispatch({
            selection: { anchor: first.to },
            effects: [
              addMarks.of(shown.map((m) => ({ ...m, at: now }))),
              EditorView.scrollIntoView(first.from, { y: 'center' }),
            ],
          });
        }),
      );
      bar.hidden = false;
    };

    const draw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        drawTicks();
        drawBar();
      });
    };
    const scroller = scrollParent(view.dom);
    const onScroll = () => {
      // An unseen change that came into sight needs no pointing at.
      if (notice) {
        if (notice.marks.some((m) => inSight(m.from))) {
          notice = undefined;
          draw();
        }
      }
    };
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(() => draw());
    resize.observe(host);
    draw();

    return {
      update(u) {
        const before = u.startState.field(field);
        const after = u.state.field(field);
        if (notice && u.docChanged)
          notice.marks = notice.marks.map((m) => {
            const from = u.changes.mapPos(m.from, 1);
            return { ...m, from, to: Math.max(from, u.changes.mapPos(m.to, -1)) };
          });
        if (before === after && !u.geometryChanged) return;
        // A new step of changes (not reviewed), partly or wholly out of sight: say where the
        // unseen part went.
        const known = new Set(before.map((m) => m.batch));
        const fresh = after.filter((m) => !known.has(m.batch) && !m.review);
        if (fresh.length) {
          const batch = fresh[fresh.length - 1]!.batch;
          const marks = fresh.filter((m) => m.batch === batch);
          view.requestMeasure({
            read: () => ({
              unseen: marks.filter((m) => !inSight(m.from)),
              partly: marks.some((m) => inSight(m.from)),
            }),
            write: ({ unseen, partly }) => {
              if (!unseen.length) return;
              notice = { marks: unseen, partly, until: Date.now() + 6000 };
              clearTimeout(noticeTimer);
              noticeTimer = setTimeout(() => {
                notice = undefined;
                draw();
              }, 6000);
              draw();
            },
          });
        }
        draw();
      },
      destroy() {
        cancelAnimationFrame(frame);
        clearTimeout(noticeTimer);
        resize.disconnect();
        scroller?.removeEventListener('scroll', onScroll);
        ticks.remove();
        bar.remove();
      },
    };
  });
}
