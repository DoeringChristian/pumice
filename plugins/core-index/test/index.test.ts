import { markdownText } from '@pumice/api';
import { DocumentsImpl, markdownCodec } from '@pumice/core-documents';
import { MarkdownSyntaxImpl } from '@pumice/core-markdown';
import { VaultImpl } from '@pumice/core-vault';
import { MemoryStorage, createMemoryPlatform } from '@pumice/platform-memory';
import { describe, expect, it } from 'vitest';
import { MetadataIndexImpl, inlineParser } from '../src';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function memoryPluginStorage() {
  const s = new MemoryStorage();
  return {
    get: (k: string) => s.get(k),
    set: (k: string, v: string) => s.set(k, v),
    delete: (k: string) => s.delete(k),
  };
}

async function setup(
  files: Record<string, string>,
  storage = memoryPluginStorage(),
  now = () => 1000,
) {
  const platform = createMemoryPlatform({ files });
  const vault = new VaultImpl(platform);
  await vault.load();
  const docs = new DocumentsImpl(vault, { saveDelay: 0 });
  docs.registerCodec(markdownCodec);
  const syntax = new MarkdownSyntaxImpl();
  const index = new MetadataIndexImpl({
    vault,
    documents: docs,
    parser: inlineParser((t) => syntax.extract(t)),
    storage,
    now,
    liveDelay: 0,
    persistDelay: 0,
  });
  await index.start();
  await index.ready;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await vault.settled();
      await docs.idle();
      await index.flush();
      await sleep(5);
    }
  };
  return { platform, vault, docs, index, settle, storage };
}

const VAULT = {
  'Home.md':
    '---\nid: k7f3qm2xa1\n---\nSee [[Meeting notes]], [[Ideas]], [[Missing]] and [[projects/Plan]].\n#home',
  'Meeting notes.md':
    '---\nid: r2p9dz4wn8\naliases: [Standup]\ntags: [work/meetings]\n---\n# Agenda\nBack to [[Home]]. ^decisions\n',
  'Ideas.md': 'Some #work idea, see [[Standup]] and [[Home#Section]].\n',
  'projects/Plan.md': '# Plan\nGoal: ship. #work/plan\n',
  'archive/Ideas.md': 'Old ideas.',
  'img.png': 'binary',
};

describe('MetadataIndex', () => {
  it('resolves by path, name and alias', async () => {
    const { index } = await setup(VAULT);
    expect(index.resolve('Meeting notes', 'Home.md')).toMatchObject({
      via: 'name',
      file: { path: 'Meeting notes.md' },
    });
    expect(index.resolve('projects/Plan', 'Home.md')).toMatchObject({
      via: 'path',
      file: { path: 'projects/Plan.md' },
    });
    // Shortest path wins between Ideas.md and archive/Ideas.md.
    expect(index.resolve('ideas', 'Home.md')).toMatchObject({
      via: 'name',
      file: { path: 'Ideas.md' },
    });
    expect(index.resolve('Standup', 'Ideas.md')).toMatchObject({
      via: 'alias',
      file: { path: 'Meeting notes.md' },
    });
    expect(index.resolve('img.png', 'projects/Plan.md')).toMatchObject({
      via: 'path',
      file: { path: 'img.png' },
    });
    expect(index.resolve('Missing', 'Home.md')).toBeUndefined();
    expect(index.resolve('', 'Home.md')).toMatchObject({ via: 'self' });
    // Note IDs are not a core concept (see the core.ids plugin).
    expect(index.resolve('r2p9dz4wn8', 'Home.md')).toBeUndefined();
  });

  it('plugins can add link resolvers', async () => {
    const { index, settle } = await setup({ ...VAULT, 'Id.md': 'See [[r2p9dz4wn8|notes]].' });
    expect(index.unresolved().map((l) => l.source)).toContain('Id.md');
    const sub = index.registerResolver((target) =>
      target === 'r2p9dz4wn8' ? 'Meeting notes.md' : undefined,
    );
    expect(index.resolve('r2p9dz4wn8', 'Id.md')).toMatchObject({
      via: 'plugin',
      file: { path: 'Meeting notes.md' },
    });
    expect(index.backlinks('Meeting notes.md').map((l) => l.source)).toContain('Id.md');
    sub.dispose();
    await settle();
    expect(index.backlinks('Meeting notes.md').map((l) => l.source)).not.toContain('Id.md');
  });

  it('backlinks, unresolved, tags, subpaths', async () => {
    const { index } = await setup(VAULT);
    expect(
      index
        .backlinks('Meeting notes.md')
        .map((l) => l.source)
        .sort(),
    ).toEqual(['Home.md', 'Ideas.md']);
    expect(
      index
        .backlinks('Home.md')
        .map((l) => l.source)
        .sort(),
    ).toEqual(['Ideas.md', 'Meeting notes.md']);
    expect(index.unresolved().map((l) => l.link.target)).toEqual(['Missing']);
    expect(index.tags().get('work')).toBe(3);
    expect(index.tags().get('work/meetings')).toBe(1);
    expect(
      index
        .filesWithTag('work')
        .map((f) => f.path)
        .sort(),
    ).toEqual(['Ideas.md', 'Meeting notes.md', 'projects/Plan.md']);
    expect(index.resolveSubpath('Meeting notes.md', '^decisions')).toMatchObject({
      id: 'decisions',
    });
    expect(index.resolveSubpath('Meeting notes.md', 'agenda')).toMatchObject({ text: 'Agenda' });
  });

  it('follows renames', async () => {
    const { vault, index, settle } = await setup(VAULT);
    await vault.rename('Meeting notes.md', 'work/Standup 2026.md');
    await settle();
    // Aliases still find it; the plain [[Meeting notes]] is now unresolved (the links plugin
    // rewrites such links on rename).
    expect(index.resolve('Standup', 'Home.md')?.file.path).toBe('work/Standup 2026.md');
    expect(index.backlinks('work/Standup 2026.md').map((l) => l.source)).toEqual(['Ideas.md']);
    await vault.create('Missing.md', 'now here');
    await settle();
    expect(index.unresolved().map((l) => l.link.target)).toEqual(['Meeting notes']);
  });

  it('indexes live document edits before they are saved', async () => {
    const { docs, index, settle } = await setup(VAULT);
    const h = await docs.open('projects/Plan.md');
    markdownText(h.doc).insert(markdownText(h.doc).length, '\nLink to [[Ideas]].');
    await settle();
    expect(index.outgoing('projects/Plan.md').map((l) => l.target)).toEqual(['Ideas.md']);
    h.dispose();
  });

  it('full-text search with snippets', async () => {
    const { index } = await setup(VAULT);
    const results = await index.search('ship');
    expect(results.map((r) => r.path)).toEqual(['projects/Plan.md']);
    const snippet = results[0]!.snippets[0]!;
    expect(snippet.text.slice(...snippet.hits[0]!)).toBe('ship');
    expect((await index.search('agend')).map((r) => r.path)).toEqual(['Meeting notes.md']);
    // Title matches rank first.
    expect(
      (await index.search('ideas'))
        .slice(0, 2)
        .map((r) => r.path)
        .sort(),
    ).toEqual(['Ideas.md', 'archive/Ideas.md']);
  });

  it('warm start from the snapshot reuses unchanged files', async () => {
    const storage = memoryPluginStorage();
    const first = await setup(VAULT, storage);
    await first.settle();
    first.index.dispose();
    let parses = 0;
    const platform = createMemoryPlatform({ files: VAULT });
    const vault = new VaultImpl(platform);
    await vault.load();
    // Same mtimes in the memory platform? Only if the platform is deterministic; compare reuse.
    const docs = new DocumentsImpl(vault, { saveDelay: 0 });
    docs.registerCodec(markdownCodec);
    const syntax = new MarkdownSyntaxImpl();
    const index = new MetadataIndexImpl({
      vault,
      documents: docs,
      parser: inlineParser((t) => (parses++, syntax.extract(t))),
      storage,
      persistDelay: 0,
    });
    await index.start();
    await index.ready;
    const sameStats = vault
      .files()
      .every(
        (f) =>
          first.vault.get(f.path)?.kind === 'file' &&
          (first.vault.get(f.path) as { mtime: number }).mtime === f.mtime,
      );
    if (sameStats) expect(parses).toBe(0);
    expect(index.resolve('Meeting notes', 'Home.md')?.file.path).toBe('Meeting notes.md');
    expect((await index.search('ship')).map((r) => r.path)).toEqual(['projects/Plan.md']);
  });
});
