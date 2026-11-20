import { DocumentsImpl, markdownCodec } from '@pumice/core-documents';
import { MetadataIndexImpl, inlineParser } from '@pumice/core-index';
import { LinksImpl } from '@pumice/core-links';
import { MarkdownSyntaxImpl } from '@pumice/core-markdown';
import { VaultImpl } from '@pumice/core-vault';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { describe, expect, it } from 'vitest';
import { NoteIdTable } from '../src';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function setup(files: Record<string, string>) {
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
    liveDelay: 0,
  });
  await index.start();
  await index.ready;
  const links = new LinksImpl({ vault, documents: docs, index });
  // What the plugin's activate() wires up.
  const ids = new NoteIdTable(index, docs);
  ids.refresh();
  index.registerResolver(ids.resolve);
  index.onDidChange((paths) => {
    if (ids.refresh(paths)) index.invalidateLinks();
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await vault.settled();
      await docs.idle();
      await index.flush();
      await sleep(60);
    }
  };
  return {
    platform,
    vault,
    docs,
    index,
    links,
    ids,
    settle,
    read: (p: string) => platform.fs.snapshot()[p],
  };
}

const NOTE = '---\nid: r2p9dz4wn8\n---\n# Agenda\n';

describe('note IDs (plugin)', () => {
  it('resolves ID links on top of name links', async () => {
    const { index, ids } = await setup({
      'Meeting notes.md': NOTE,
      'Home.md': 'By id [[r2p9dz4wn8|the meeting]], by name [[Meeting notes]].',
    });
    expect(ids.idOf('Meeting notes.md')).toBe('r2p9dz4wn8');
    expect(index.resolve('r2p9dz4wn8', 'Home.md')).toMatchObject({
      via: 'plugin',
      file: { path: 'Meeting notes.md' },
    });
    expect(index.outgoing('Home.md').map((l) => [l.via, l.target])).toEqual([
      ['plugin', 'Meeting notes.md'],
      ['name', 'Meeting notes.md'],
    ]);
    // An ID-shaped name that is no ID is left to the normal rules.
    expect(index.resolve('zzzzzzzzzz', 'Home.md')).toBeUndefined();
  });

  it('ID links survive renames and moves made outside the app', async () => {
    const { platform, vault, index, settle } = await setup({
      'Meeting notes.md': NOTE,
      'Home.md': '[[r2p9dz4wn8|the meeting]]',
    });
    await vault.rename('Meeting notes.md', 'work/Standup.md');
    await settle();
    expect(index.resolve('r2p9dz4wn8', 'Home.md')?.file.path).toBe('work/Standup.md');
    platform.fs.external.remove('work/Standup.md');
    platform.fs.external.write('moved/Notes.md', NOTE);
    await settle();
    expect(index.resolve('r2p9dz4wn8', 'Home.md')?.file.path).toBe('moved/Notes.md');
    expect(index.backlinks('moved/Notes.md').map((l) => l.source)).toEqual(['Home.md']);
  });

  it('duplicates: the note higher up keeps the ID until fixed', async () => {
    const { vault, ids, settle } = await setup({ 'Meeting notes.md': NOTE });
    await vault.create('archive/Copy.md', NOTE);
    await settle();
    expect(ids.duplicates()).toEqual([['r2p9dz4wn8', ['Meeting notes.md', 'archive/Copy.md']]]);
    expect(ids.pathOf('r2p9dz4wn8')).toBe('Meeting notes.md');
    const fresh = await ids.reassign('archive/Copy.md');
    await settle();
    expect(ids.duplicates()).toEqual([]);
    expect(ids.pathOf(fresh)).toBe('archive/Copy.md');
  });

  it('writes [[id|Name]] links when used as the link formatter', async () => {
    const { links, ids, index, settle, read } = await setup({
      'Home.md': '',
      'Plain note.md': '# Text\n',
      'img.png': 'x',
    });
    links.registerLinkFormatter((file, opts) => ids.formatLink(file, opts));
    const text = links.suggest('plain', 'Home.md')[0]!.insert({ embed: false, inTable: false });
    const m = /^\[\[([0-9a-z]{10})\|Plain note\]\]$/.exec(text);
    expect(m).toBeTruthy();
    await settle();
    // The target got its ID, and the link resolves to it.
    expect(read('Plain note.md')).toBe(`---\nid: ${m![1]}\n---\n# Text\n`);
    expect(index.resolve(m![1]!, 'Home.md')?.file.path).toBe('Plain note.md');
    // Asking again reuses the ID; non-notes keep plain links.
    expect(links.formatLink('Plain note.md', { subpath: 'Text' })).toBe(
      `[[${m![1]}#Text|Plain note › Text]]`,
    );
    expect(links.formatLink('img.png')).toBe('[[img.png]]');
  });
});
