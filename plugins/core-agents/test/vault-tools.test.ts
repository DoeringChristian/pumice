import { describe, expect, it } from 'vitest';
import { ChatStore } from '../src/chats';
import { vaultPath, vaultTools, type VaultToolContext } from '../src/vault-tools';

function context(initial: Record<string, string>) {
  const text = new Map(Object.entries(initial));
  const writes: string[] = [];
  const ctx: VaultToolContext = {
    files: {
      root: '/vault',
      read: async (p) => {
        if (!text.has(p)) throw new Error('no such file');
        return text.get(p)!;
      },
      write: async (p, c) => {
        writes.push(p);
        text.set(p, c);
      },
    },
    vault: {
      get: (p: string) => (text.has(p) ? { path: p, kind: 'file' } : undefined),
      files: () => [...text.keys()].map((path) => ({ path })),
    } as never,
  };
  const tool = (name: string) => vaultTools(ctx).find((t) => t.name === name)!;
  const call = { beforeWrite: async () => undefined };
  return { text, writes, tool, call, ctx };
}

describe('the vault’s tools', () => {
  it('refuses an edit with a missing argument instead of deleting', async () => {
    const { text, writes, tool, call, ctx } = context({ 'n.md': 'Keep this.' });
    await expect(
      tool('edit_note').run({ path: 'n.md', old_text: 'Keep' }, ctx, call),
    ).rejects.toThrow(/new_text/);
    await expect(tool('create_note').run({ path: 'new.md' }, ctx, call)).rejects.toThrow(/content/);
    expect(writes).toEqual([]);
    // Given empty, on purpose: deleted.
    await tool('edit_note').run({ path: 'n.md', old_text: ' this', new_text: '' }, ctx, call);
    expect(text.get('n.md')).toBe('Keep.');
  });

  it('takes paths in the vault only, relative or absolute in it', () => {
    expect(vaultPath('notes/a.md')).toBe('notes/a.md');
    expect(vaultPath('/vault/notes/a.md', '/vault')).toBe('notes/a.md');
    expect(() => vaultPath('../secret.md')).toThrow();
    expect(() => vaultPath('.pumice/chats/index.json')).toThrow();
    expect(() => vaultPath(undefined)).toThrow();
  });

  it('offers search and links only with an index, drawings only with drawings', () => {
    const { ctx } = context({});
    expect(vaultTools(ctx).map((t) => t.name)).toEqual([
      'list_notes',
      'read_note',
      'edit_note',
      'create_note',
    ]);
    expect(vaultTools(ctx, { readOnly: true }).some((t) => t.writes)).toBe(false);
  });
});

describe('chat files', () => {
  it('never names the folder’s own files as a chat', async () => {
    const stored = new Map<string, string>();
    const store = new ChatStore({
      stat: async (p: string) => (stored.has(p) ? ({ path: p } as never) : null),
      readText: async (p: string) => stored.get(p)!,
      write: async (p: string, d: string | Uint8Array) => {
        stored.set(p, String(d));
        return { path: p } as never;
      },
      remove: async () => undefined,
    } as never);
    const said = { items: [{ kind: 'user' as const, id: 1, text: 'hi' }] };
    for (const id of ['open', 'index', 'Ledger'])
      await expect(store.save(id, 'claude', said)).rejects.toThrow(/Not a chat id/);
    expect([...stored.keys()]).toEqual([]);
  });
});
