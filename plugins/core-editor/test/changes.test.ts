import { AuthoredChange, Emitter, ORIGIN_EXTERNAL_FILE, type OpenedDocument } from '@pumice/api';
import { applyTextDiff, applyTextDiffAs } from '@pumice/core-documents';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ChangeTracker, detectAuthor, hunksOf, undoable, type TrackedChange } from '../src/changes';

const claude = { kind: 'agent' as const, name: 'Claude', color: '#8b5cf6' };

function setup(text: string, review = false) {
  const opened = new Emitter<OpenedDocument>();
  const tracker = new ChangeTracker({ onDidOpen: opened.event }, () => review);
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, text);
  opened.fire({ doc, codec: { id: 'markdown' } as OpenedDocument['codec'], path: 'a.md' });
  const seen: TrackedChange[][] = [];
  tracker.onDidAdd((e) => seen.push(e.changes));
  const edit = (target: string, origin: unknown = new AuthoredChange(claude)) =>
    doc.transact(() => applyTextDiff(ytext, target), origin);
  return { tracker, doc, ytext, seen, edit };
}

describe('changes not typed here', () => {
  it('reports each place an assistant changed, with what it replaced', () => {
    const { seen, edit } = setup('The first line.\nUnchanged middle.\nThe last line.\n');
    edit('The 1st line.\nUnchanged middle.\nThe final line.\n');
    expect(seen).toHaveLength(1);
    const changes = seen[0]!;
    expect(changes.map((c) => [c.removed, c.inserted])).toEqual([
      ['first', '1st'],
      ['last', 'final'],
    ]);
    expect(changes.every((c) => c.author.name === 'Claude' && c.batch === changes[0]!.batch)).toBe(
      true,
    );
    expect(changes[0]!.review).toBe(false);
  });

  it('shows a deletion as a place with the removed text', () => {
    const { seen, edit } = setup('Keep this. Drop this sentence. Keep that.');
    edit('Keep this. Keep that.');
    expect(seen[0]).toMatchObject([{ inserted: '', removed: 'Drop this sentence. ' }]);
  });

  it('ignores typing here, and marks changes from the file on disk', () => {
    const { seen, edit } = setup('abc');
    edit('abcd', null);
    expect(seen).toHaveLength(0);
    edit('abcde', ORIGIN_EXTERNAL_FILE);
    expect(seen[0]![0]!.author.kind).toBe('file');
  });

  it('keeps changes for review and finds them again after other edits', () => {
    const { tracker, doc, ytext, edit } = setup('One. Two. Three.', true);
    edit('One. Two and a half. Three.');
    ytext.insert(0, 'Zero. ');
    const [kept] = tracker.list('a.md', doc);
    expect(ytext.toString().slice(kept!.from, kept!.to)).toBe(' and a half');
    tracker.remove('a.md', [kept!.id]);
    expect(tracker.list('a.md', doc)).toEqual([]);
  });

  it('finds a kept change in the note opened anew (from its text)', () => {
    const { tracker, ytext, edit } = setup('Alpha beta gamma delta.', true);
    edit('Alpha beta (inserted words) gamma delta.');
    const again = new Y.Doc();
    again.getText('content').insert(0, `Heading\n\n${ytext.toString()}`);
    const [kept] = tracker.list('a.md', again);
    expect(kept!.inserted.trim()).toBe('(inserted words)');
    expect(again.getText('content').toString().slice(kept!.from, kept!.to)).toBe(kept!.inserted);
    expect(kept!.from).toBeGreaterThan('Heading\n\nAlpha beta'.length - 1);
  });

  it('attributes a change from another client to its assistant or person, for good', () => {
    const here = new Y.Doc();
    const there = new Y.Doc();
    here.getText('content').insert(0, 'Hello world, this is a test.');
    Y.applyUpdate(there, Y.encodeStateAsUpdate(here));
    // The other app's assistant edits as a client of its own, listed in that app's presence.
    const agentClient = 4242;
    const states = new Map<number, unknown>([
      [
        there.clientID,
        {
          user: { name: 'Ada', color: '#f00' },
          agents: [{ client: agentClient, name: 'Claude', color: '#8b5cf6' }],
        },
      ],
    ]);
    const awareness = { getStates: () => states, clientID: here.clientID };
    let found: ReturnType<typeof detectAuthor>;
    here.on('beforeObserverCalls', (tr: Y.Transaction) => (found = detectAuthor(tr, awareness)));
    const send = () => Y.applyUpdate(here, Y.encodeStateAsUpdate(there, Y.encodeStateVector(here)));

    applyTextDiffAs(
      there,
      'content',
      `> ${there.getText('content').toString()}`,
      agentClient,
      null,
    );
    send();
    expect(found!).toMatchObject({ author: { kind: 'agent', name: 'Claude' }, reviewable: true });

    // The person typing right after is the person, not the assistant.
    there.getText('content').insert(7, ' there');
    send();
    expect(found!).toMatchObject({ author: { kind: 'person', name: 'Ada' }, reviewable: false });

    // A deletion alone carries no author in Yjs: shown without a name, never kept for review.
    there.getText('content').delete(0, 2);
    send();
    expect(found!).toMatchObject({ author: { name: '' }, reviewable: false, always: false });
  });

  it('marks an assistant filling an empty note, not the first sync of a shared one', () => {
    const { seen, edit } = setup('');
    edit('A whole new note.');
    expect(seen[0]).toMatchObject([{ inserted: 'A whole new note.', removed: '' }]);

    // A shared note: its first state from the server is no change; once it has it, an
    // assistant elsewhere filling it (empty) is.
    const opened = new Emitter<OpenedDocument>();
    const tracker = new ChangeTracker({ onDidOpen: opened.event }, () => false);
    const doc = new Y.Doc();
    let hasFirstState = false;
    opened.fire({
      doc,
      codec: { id: 'markdown' } as OpenedDocument['codec'],
      path: 'b.md',
      get synced() {
        return hasFirstState;
      },
    });
    const synced: TrackedChange[][] = [];
    tracker.onDidAdd((e) => synced.push(e.changes));
    const server = new Y.Doc();
    server.getText('content').insert(0, 'Content that arrives from the server on first sync.');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    expect(synced).toEqual([]);
    hasFirstState = true;
    const before = Y.encodeStateVector(server);
    server.getText('content').delete(0, server.getText('content').length);
    server.getText('content').insert(0, 'Filled anew by someone elsewhere, a whole paragraph.');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, before));
    expect(synced).toHaveLength(1);
  });

  it('keeps what a change left, so text written into it since is not undone with it', () => {
    const { tracker, doc, ytext, edit } = setup('One. Two. Three.', true);
    edit('One. Two and a half. Three.');
    // Someone writes into the change; an editor opened now gets the change from the tracker.
    const at = ytext.toString().indexOf('a half');
    ytext.insert(at, 'roughly ');
    const [kept] = tracker.list('a.md', doc);
    const text = ytext.toString();
    expect(undoable([kept!], (from, to) => text.slice(from, to)).changed).toHaveLength(1);
  });
});

describe('undoing a change', () => {
  const mark = (from: number, to: number, inserted: string) =>
    ({ id: from, from, to, inserted, removed: 'x' }) as TrackedChange;
  it('only where its text is still what the change left, and not twice over a place', () => {
    const text = 'aaa NEW bbb OTHER ccc';
    const at = (from: number, to: number) => text.slice(from, to);
    expect(undoable([mark(4, 7, 'NEW')], at).ok).toHaveLength(1);
    // Someone wrote into it since.
    expect(undoable([mark(4, 7, 'NE')], at).changed).toHaveLength(1);
    // Two marks over the same text: only one is undone.
    const r = undoable([mark(4, 11, 'NEW bbb'), mark(8, 11, 'bbb')], at);
    expect([r.ok.length, r.changed.length]).toEqual([1, 1]);
  });
});

describe('changes in whole words', () => {
  it('slides a deletion to word boundaries', async () => {
    const { wholeWords } = await import('../src/changes');
    // "angle. This sentence repeats. The amplitude" → "angle. The amplitude", found mid-word.
    const text = 'angle. The amplitude';
    const h = wholeWords({ from: 9, to: 9, removed: 'is sentence repeats. Th' }, text);
    expect(text.slice(0, h.from) + h.removed + text.slice(h.from)).toBe(
      'angle. This sentence repeats. The amplitude',
    );
    expect(h.removed).toBe('This sentence repeats. ');
  });

  it('widens a replacement inside words to the words', async () => {
    const { wholeWords } = await import('../src/changes');
    const text = 'the color of it';
    const h = wholeWords({ from: 8, to: 8, removed: 'u' }, text);
    expect(h).toEqual({ from: 4, to: 9, removed: 'colour' });
    const t2 = 'close to 2.0 s for small angles, as';
    const r = wholeWords({ from: 0, to: 30, removed: 'roughly 2 second' }, t2);
    expect(t2.slice(r.from, r.to)).toBe('close to 2.0 s for small angles');
    expect(r.removed).toBe('roughly 2 seconds');
  });
});

describe('a section added', () => {
  it('is placed as whole lines, before the next heading', () => {
    const doc = new Y.Doc();
    const t = doc.getText('content');
    t.insert(0, 'Fit text.\n\n## Open questions\n\n- a\n');
    let out: unknown;
    t.observe((e) => (out = hunksOf(e, t)));
    t.insert(11, '## Summary\n\nDamping is weak.\n\n');
    expect(out).toEqual([{ from: 11, to: 41, removed: '' }]);
  });
});
