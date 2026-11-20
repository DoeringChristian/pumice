import { describe, expect, it } from 'vitest';
import type { PlatformFs } from '@pumice/api';
import { ChatStore, age, chatTitle, storableItems } from '../src/chats';
import { splitQuotes, withQuotes } from '../src/panel';
import type { TranscriptItem } from '../src/session';

function memoryFs() {
  const files: Record<string, string> = {};
  const fs = {
    stat: async (p: string) => (p in files ? { path: p } : null),
    readText: async (p: string) => {
      if (!(p in files)) throw new Error('missing');
      return files[p]!;
    },
    write: async (p: string, data: string) => void (files[p] = data),
    remove: async (p: string) => void delete files[p],
  } as unknown as PlatformFs;
  return { fs, files };
}

const items: TranscriptItem[] = [
  {
    kind: 'user',
    id: 1,
    text: 'Plan the   release\nfor next week please, and check the notes too, thanks a lot',
  },
  {
    kind: 'tool',
    id: 2,
    toolCallId: 'c',
    title: 'Read',
    status: 'in_progress',
    content: [],
    locations: [],
  },
  { kind: 'permission', id: 3, title: 'Edit', options: [], respond: () => undefined },
  { kind: 'agent', id: 4, text: 'Done' },
];

describe('chats', () => {
  it('names a chat after its first message', () => {
    expect(chatTitle(items)).toMatch(/^Plan the release for next week please, and check .*…$/);
    expect(chatTitle(items).length).toBeLessThanOrEqual(58);
    expect(chatTitle([])).toBe('New chat');
  });

  it('stores nothing that is still waiting or running', () => {
    const stored = storableItems(items);
    expect(stored[1]).toMatchObject({ status: 'cancelled' });
    expect(stored[2]).toMatchObject({ chosen: 'cancelled' });
    expect('respond' in stored[2]!).toBe(false);
    expect(() => JSON.stringify(stored)).not.toThrow();
  });

  it('describes how old a chat is', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    expect(age('2026-11-20T11:59:50Z', now)).toBe('just now');
    expect(age('2026-11-20T11:40:00Z', now)).toBe('20 min ago');
    expect(age('2026-11-20T09:00:00Z', now)).toBe('3 h ago');
    expect(age('2026-11-19T10:00:00Z', now)).toBe('yesterday');
  });

  it('saves, lists most recent first, loads and removes', async () => {
    const { fs, files } = memoryFs();
    const store = new ChatStore(fs);
    await store.save('a', 'chatgpt', { items: [{ kind: 'info', id: 1, text: 'empty' }] });
    expect(await store.list()).toEqual([]);

    await store.save('a', 'chatgpt', { items, input: [{ type: 'message' }] });
    await new Promise((r) => setTimeout(r, 5));
    await store.save('b', 'claude', {
      items: [{ kind: 'user', id: 1, text: 'Second' }],
      sessionId: 's1',
    });
    expect((await store.list()).map((c) => [c.id, c.agent, c.title])).toEqual([
      ['b', 'claude', 'Second'],
      ['a', 'chatgpt', chatTitle(items)],
    ]);
    // Another start of the app reads the same files.
    const again = new ChatStore(fs);
    expect((await again.list()).map((c) => c.id)).toEqual(['b', 'a']);
    expect((await again.load('b'))?.sessionId).toBe('s1');
    expect((await again.load('a'))?.input).toEqual([{ type: 'message' }]);
    expect(await again.load('nope')).toBeUndefined();

    const created = (await store.list())[1]!.created;
    await store.save('a', 'chatgpt', { items });
    expect((await store.list()).map((c) => c.id)).toEqual(['a', 'b']);
    expect((await store.list())[0]!.created).toBe(created);

    await store.remove('a');
    expect((await store.list()).map((c) => c.id)).toEqual(['b']);
    expect(files['.pumice/chats/a.json']).toBeUndefined();
  });

  it('writes replies to passages as quotes and reads them back', () => {
    const message = withQuotes(
      ['first line\nsecond line', 'another'],
      'What about this?\n> not a quote',
    );
    expect(message).toBe(
      '> first line\n> second line\n\n> another\n\nWhat about this?\n> not a quote',
    );
    expect(splitQuotes(message)).toEqual({
      quotes: ['first line\nsecond line', 'another'],
      rest: 'What about this?\n> not a quote',
    });
    expect(withQuotes([], 'plain')).toBe('plain');
    expect(splitQuotes('plain')).toEqual({ quotes: [], rest: 'plain' });
  });
});
