import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { DocumentsImpl, markdownCodec } from '@pumice/core-documents';
import { MetadataIndexImpl, inlineParser } from '@pumice/core-index';
import { MarkdownSyntaxImpl } from '@pumice/core-markdown';
import { VaultImpl } from '@pumice/core-vault';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { describe, expect, it } from 'vitest';
import { renameLabel } from '../src/references';
import { LinksImpl, pointedAt, rewriteLinksAfterRename } from '../src';

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
  const opened: Array<{ path: string; state?: unknown }> = [];
  const workspace = {
    openFile: async (path: string, opts?: { state?: unknown }) => {
      opened.push({ path, state: opts?.state });
    },
  } as never;
  const links = new LinksImpl({ vault, documents: docs, index, workspace });
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await vault.settled();
      await docs.idle();
      await index.flush();
      await sleep(5);
    }
  };
  const read = (p: string) => platform.fs.snapshot()[p];
  return { platform, vault, docs, index, links, settle, read, opened };
}

describe('links', () => {
  it('suggestions insert plain [[Name]] links and leave the target note alone', async () => {
    const { links, settle, read } = await setup({
      'Home.md': 'hi',
      'Meeting notes.md': '# Agenda\n',
      'a/Dup.md': '',
      'b/Dup.md': '',
      'img.png': 'x',
    });
    const [first] = links.suggest('meet', 'Home.md');
    expect(first?.label).toBe('Meeting notes');
    expect(first!.insert({ embed: false, inTable: false })).toBe('[[Meeting notes]]');
    expect(links.suggest('meet', 'Home.md')[0]!.insert({ embed: true, inTable: true })).toBe(
      '![[Meeting notes]]',
    );
    await settle();
    expect(read('Meeting notes.md')).toBe('# Agenda\n');
    // Ambiguous names are written with their path; other files keep their extension.
    expect(links.formatLink('a/Dup.md')).toBe('[[a/Dup]]');
    expect(links.formatLink('img.png', { embed: true })).toBe('![[img.png]]');
    expect(links.formatLink('Meeting notes.md', { alias: 'the meeting' })).toBe(
      '[[Meeting notes|the meeting]]',
    );
  });

  it('heading and block suggestions', async () => {
    const { links } = await setup({
      'A.md': '# Intro\n## Details\ntext ^blk\n',
    });
    expect(links.suggest('A#det', 'B.md').map((s) => s.label)).toEqual(['## Details']);
    expect(links.suggest('A#det', 'B.md')[0]!.insert({ embed: false, inTable: false })).toBe(
      '[[A#Details]]',
    );
    expect(links.suggest('A#^', 'B.md')[0]!.insert({ embed: false, inTable: false })).toBe(
      '[[A#^blk]]',
    );
    expect(links.suggest('#^', 'A.md')[0]!.insert({ embed: false, inTable: false })).toBe(
      '[[#^blk]]',
    );
  });

  it('display text and link formatters', async () => {
    const { links } = await setup({ 'Some note.md': '', 'Home.md': '' });
    expect(links.displayText({ target: 'Some note' }, 'Home.md')).toBe('Some note');
    expect(links.displayText({ target: 'Some note', subpath: 'Part' }, 'Home.md')).toBe(
      'Some note › Part',
    );
    expect(links.displayText({ target: 'Some note', alias: 'my words' }, 'Home.md')).toBe(
      'my words',
    );
    // A plugin (note IDs) can decide how links are written.
    const sub = links.registerLinkFormatter((file) => `[[x-${file.name}]]`);
    expect(links.formatLink('Some note.md')).toBe('[[x-Some note]]');
    expect(links.suggest('some', 'Home.md')[0]!.insert({ embed: false, inTable: false })).toBe(
      '[[x-Some note]]',
    );
    sub.dispose();
    expect(links.formatLink('Some note.md')).toBe('[[Some note]]');
  });

  it('clicking an unresolved link creates an empty note and keeps the link', async () => {
    const { links, settle, read, opened } = await setup({ 'Home.md': 'See [[New idea]] now.' });
    await links.openLink('New idea', { sourcePath: 'Home.md' });
    await settle();
    expect(read('New idea.md')).toBe('');
    expect(read('Home.md')).toBe('See [[New idea]] now.');
    expect(opened.map((o) => o.path)).toEqual(['New idea.md']);
  });

  it('renames rewrite links, as in Obsidian', async () => {
    const files = {
      'Target.md': '---\nid: cccccccccc\n---\n',
      'A.md':
        'Plain [[Target]], aliased [[Target|t]], heading [[Target#H]], other [[cccccccccc|Target]], md [x](Target.md).',
      'sub/B.md': 'Path [[Target.md]] and embed ![[Target]].',
    };
    const { vault, index, docs, settle, read } = await setup(files);
    await vault.rename('Target.md', 'folder/Renamed.md');
    await settle();
    const n = await rewriteLinksAfterRename(
      [{ oldPath: 'Target.md', newPath: 'folder/Renamed.md' }],
      index,
      docs,
    );
    await settle();
    expect(n).toBe(6);
    expect(read('A.md')).toBe(
      'Plain [[Renamed]], aliased [[Renamed|t]], heading [[Renamed#H]], other [[cccccccccc|Target]], md [x](Renamed.md).',
    );
    expect(read('sub/B.md')).toBe('Path [[Renamed.md]] and embed ![[Renamed]].');
  });

  it('pointedAt', () => {
    expect(pointedAt('Note', 'x/Note.md', 'a.md')).toBe(true);
    expect(pointedAt('x/note', 'x/Note.md', 'a.md')).toBe(true);
    expect(pointedAt('../x/Note', 'x/Note.md', 'y/a.md')).toBe(true);
    expect(pointedAt('Other', 'x/Note.md', 'a.md')).toBe(false);
  });
});

describe('renaming a label', () => {
  it('changes every link to it, of either form, in the note and in others', async () => {
    const note =
      '![[a.png]]{#fig-a}\n\n@fig-a [[#fig-a]] [[Note#fig-a]] [[Note#^fig-a|it]] [[Other#fig-a]]\n';
    const { index, docs, settle, read } = await setup({
      'Note.md': note,
      'Other.md': 'x {#fig-a}\n\n[[Note#fig-a]] [[Note#^fig-a|b]] [[#fig-a]]\n',
    });
    let state = EditorState.create({ doc: note });
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: TransactionSpec) => (state = state.update(spec).state),
    } as unknown as EditorView;
    expect(await renameLabel(view, 'Note.md', 'fig-a', 'fig-x', { index, documents: docs })).toBe(
      1,
    );
    await settle();
    expect(state.doc.toString()).toBe(
      '![[a.png]]{#fig-x}\n\n@fig-x [[#fig-x]] [[Note#fig-x]] [[Note#^fig-x|it]] [[Other#fig-a]]\n',
    );
    expect(await read('Other.md')).toBe(
      'x {#fig-a}\n\n[[Note#fig-x]] [[Note#^fig-x|b]] [[#fig-a]]\n',
    );
  });
});
