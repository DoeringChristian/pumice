import type { VaultChange } from '@pumice/api';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { describe, expect, it } from 'vitest';
import { VaultImpl } from '../src';

async function setup(files: Record<string, string>) {
  const platform = createMemoryPlatform({ files });
  const vault = new VaultImpl(platform);
  await vault.load();
  const changes: VaultChange[] = [];
  vault.onDidChange((c) => changes.push(...c));
  return { platform, vault, changes };
}

describe('VaultImpl', () => {
  it('loads the tree and hides dot folders', async () => {
    const { vault } = await setup({
      'a.md': '# A',
      'notes/b.md': 'B',
      '.pumice/settings.json': '{}',
      '.git/HEAD': 'ref',
    });
    expect(
      vault
        .files()
        .map((f) => f.path)
        .sort(),
    ).toEqual(['a.md', 'notes/b.md']);
    expect(vault.children('').map((e) => e.name)).toEqual(['notes', 'a.md']);
    expect(vault.get('notes/b.md')).toMatchObject({ basename: 'b', extension: 'md' });
  });

  it('creates files with missing parent folders', async () => {
    const { vault, changes } = await setup({});
    await vault.create('x/y/z.md', 'hi');
    expect(changes.map((c) => [c.type, 'entry' in c ? c.entry.path : c.path])).toEqual([
      ['create', 'x'],
      ['create', 'x/y'],
      ['create', 'x/y/z.md'],
    ]);
    await expect(vault.create('x/y/z.md', 'again')).rejects.toThrow(/exists/);
  });

  it('renames folders with their contents', async () => {
    const { vault, changes } = await setup({ 'f/a.md': 'a', 'f/sub/b.md': 'b' });
    await vault.rename('f', 'g');
    expect(
      vault
        .files()
        .map((f) => f.path)
        .sort(),
    ).toEqual(['g/a.md', 'g/sub/b.md']);
    expect(changes.filter((c) => c.type === 'rename').length).toBe(4);
    expect(await vault.read('g/sub/b.md')).toBe('b');
  });

  it('reports external changes and ignores echoes of its own writes', async () => {
    const { platform, vault, changes } = await setup({ 'a.md': 'a' });
    await vault.write('a.md', 'mine');
    changes.length = 0;
    platform.fs.external.write('a.md', 'theirs');
    await vault.settled();
    platform.fs.external.write('new/n.md', 'n');
    await vault.settled();
    platform.fs.external.remove('a.md');
    await vault.settled();
    expect(changes.map((c) => [c.type, 'entry' in c ? c.entry.path : c.path, c.external])).toEqual([
      ['modify', 'a.md', true],
      ['create', 'new', true],
      ['create', 'new/n.md', true],
      ['delete', 'a.md', true],
    ]);
  });

  it('coalesces changes by stat-ing at processing time', async () => {
    const { platform, vault, changes } = await setup({ 'a.md': 'a' });
    platform.fs.external.write('a.md', 'theirs');
    platform.fs.external.remove('a.md');
    await vault.settled();
    expect(changes.map((c) => c.type)).toEqual(['delete']);
  });

  it('rescans to pick up changes without a watcher', async () => {
    const { platform, vault, changes } = await setup({ 'a.md': 'a', 'b.md': 'b' });
    // Bypass the watcher: mutate the fs directly.
    await platform.fs.write('c.md', 'c');
    await platform.fs.remove('b.md');
    await vault.rescan();
    expect(changes.map((c) => c.type).sort()).toEqual(['create', 'delete']);
  });

  it('finds available paths', async () => {
    const { vault } = await setup({ 'Untitled.md': '', 'Untitled 1.md': '' });
    expect(vault.availablePath('', 'Untitled', 'md')).toBe('Untitled 2.md');
  });
});
