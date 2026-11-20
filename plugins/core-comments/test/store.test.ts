import { describe, expect, it } from 'vitest';
import type { DocumentsApi, MetadataIndexApi, PlatformFs } from '@pumice/api';
import { CommentStore } from '../src/store';

function setup() {
  const files: Record<string, string> = {};
  const fs = {
    stat: async (p: string) => (p in files ? { path: p } : null),
    readText: async (p: string) => files[p]!,
    write: async (p: string, data: string) => void (files[p] = data),
    remove: async (p: string) => void delete files[p],
  } as unknown as PlatformFs;
  const store = new CommentStore({
    fs,
    index: { getFile: () => ({ path: 'note.md' }) } as unknown as MetadataIndexApi,
    documents: {
      read: async () => 'Hello world, this is a note.',
      peek: () => 'Hello world, this is a note.',
    } as unknown as DocumentsApi,
    author: () => 'Me',
  });
  return { store, files };
}

describe('deleting comments', () => {
  it('brings a deleted thread back where it was', async () => {
    const { store } = setup();
    const a = await store.addThread('note.md', { from: 0, to: 5 }, 'first');
    const b = await store.addThread('note.md', { from: 6, to: 11 }, 'second');
    await store.deleteThread('note.md', a.id);
    expect((await store.threads('note.md')).map((t) => t.id)).toEqual([b.id]);
    expect(store.canUndoDelete).toBe(true);
    expect(await store.undoDelete()).toBe('note.md');
    expect((await store.threads('note.md')).map((t) => t.comments[0]!.body)).toEqual([
      'first',
      'second',
    ]);
    expect(store.canUndoDelete).toBe(false);
    expect(await store.undoDelete()).toBeUndefined();
  });

  it('brings back a reply, and a thread that went with its last comment', async () => {
    const { store } = setup();
    const t = await store.addThread('note.md', { from: 0, to: 5 }, 'question');
    const reply = await store.reply('note.md', t.id, 'answer');
    await store.reply('note.md', t.id, 'thanks');
    await store.deleteComment('note.md', t.id, reply.id);
    await store.undoDelete();
    expect((await store.threads('note.md'))[0]!.comments.map((c) => c.body)).toEqual([
      'question',
      'answer',
      'thanks',
    ]);

    const lone = await store.addThread('note.md', { from: 6, to: 11 }, 'alone');
    await store.deleteComment('note.md', lone.id, lone.comments[0]!.id);
    expect(await store.threads('note.md')).toHaveLength(1);
    await store.undoDelete();
    expect((await store.threads('note.md')).map((x) => x.comments[0]!.body)).toEqual([
      'question',
      'alone',
    ]);
  });

  it('undoes the most recent deletion first', async () => {
    const { store } = setup();
    const a = await store.addThread('note.md', { from: 0, to: 5 }, 'a');
    const b = await store.addThread('note.md', { from: 6, to: 11 }, 'b');
    await store.deleteThread('note.md', a.id);
    await store.deleteThread('note.md', b.id);
    await store.undoDelete();
    expect((await store.threads('note.md')).map((t) => t.comments[0]!.body)).toEqual(['b']);
    await store.undoDelete();
    expect((await store.threads('note.md')).map((t) => t.comments[0]!.body)).toEqual(['a', 'b']);
  });
});
