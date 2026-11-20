import { markdownText } from '@pumice/api';
import { VaultImpl } from '@pumice/core-vault';
import { createMemoryPlatform } from '@pumice/platform-memory';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocumentsImpl, markdownCodec } from '../src';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function setup(files: Record<string, string>) {
  const platform = createMemoryPlatform({ files });
  const vault = new VaultImpl(platform);
  await vault.load();
  const docs = new DocumentsImpl(vault, {
    saveDelay: 0,
    now: () => new Date('2026-10-31T15:30:00Z'),
  });
  docs.registerCodec(markdownCodec);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await vault.settled();
      await docs.idle();
      await sleep();
    }
  };
  return { platform, vault, docs, settle };
}

describe('DocumentsImpl', () => {
  it('shares one doc between handles and saves edits', async () => {
    const { platform, docs, settle } = await setup({ 'a.md': 'hello' });
    const h1 = await docs.open('a.md');
    const h2 = await docs.open('a.md');
    expect(h1.doc).toBe(h2.doc);
    markdownText(h1.doc).insert(5, ' world');
    await settle();
    expect(platform.fs.snapshot()['a.md']).toBe('hello world');
    h1.dispose();
    expect(docs.isOpen('a.md')).toBe(true);
    h2.dispose();
    await settle();
    expect(docs.isOpen('a.md')).toBe(false);
  });

  it('merges external edits with unsaved local edits', async () => {
    const { platform, docs, settle } = await setup({ 'a.md': 'line 1\nline 2\nline 3\n' });
    const h = await docs.open('a.md');
    const text = markdownText(h.doc);
    text.insert(0, '# Title\n'); // not yet saved
    platform.fs.external.write('a.md', 'line 1\nline 2\nline 3\nline 4 (from elsewhere)\n');
    await settle();
    const expected = '# Title\nline 1\nline 2\nline 3\nline 4 (from elsewhere)\n';
    expect(text.toString()).toBe(expected);
    expect(platform.fs.snapshot()['a.md']).toBe(expected);
  });

  it('saves a conflict copy on true conflicts', async () => {
    const { platform, docs, settle } = await setup({ 'notes/a.md': 'status: draft\n' });
    const h = await docs.open('notes/a.md');
    const text = markdownText(h.doc);
    text.delete(8, 5);
    text.insert(8, 'final');
    platform.fs.external.write('notes/a.md', 'status: review\n');
    await settle();
    const files = platform.fs.snapshot();
    expect(files['notes/a.md']).toBe('status: final\n');
    expect(files['notes/a (conflict 2026-10-31 1530).md']).toBe('status: review\n');
  });

  it('follows renames and stops saving after delete', async () => {
    const { platform, vault, docs, settle } = await setup({ 'a.md': 'x' });
    const h = await docs.open('a.md');
    const renamed: string[] = [];
    h.onDidRename((p) => renamed.push(p));
    await vault.rename('a.md', 'b.md');
    expect(h.path).toBe('b.md');
    expect(renamed).toEqual(['b.md']);
    markdownText(h.doc).insert(1, 'y');
    await settle();
    expect(platform.fs.snapshot()['b.md']).toBe('xy');
    let deleted = false;
    h.onDidDelete(() => (deleted = true));
    await vault.delete('b.md');
    markdownText(h.doc).insert(2, 'z');
    await settle();
    expect(deleted).toBe(true);
    expect(platform.fs.snapshot()).toEqual({});
  });

  it('preserves CRLF line endings', async () => {
    const { platform, docs, settle } = await setup({ 'w.md': 'a\r\nb\r\n' });
    const h = await docs.open('w.md');
    expect(markdownText(h.doc).toString()).toBe('a\nb\n');
    markdownText(h.doc).insert(4, 'c\n');
    await settle();
    expect(platform.fs.snapshot()['w.md']).toBe('a\r\nb\r\nc\r\n');
  });
});

/** Spike S2: editor, disk and a remote peer edit concurrently; nothing may be lost or duplicated. */
describe('reconciliation fuzz', () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
  }

  const lineStarts = (s: string) => [
    0,
    ...[...s.matchAll(/\n/g)].map((m) => m.index! + 1).filter((i) => i <= s.length),
  ];

  async function run(seed: number) {
    const random = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
    const initial = Array.from({ length: 12 }, (_, i) => `filler ${i}\n`).join('');
    const { platform, docs, settle } = await setup({ 'n.md': initial });
    const h = await docs.open('n.md');
    const local = markdownText(h.doc);

    // A remote peer with a delayed, two-way connection.
    const peerDoc = new Y.Doc();
    const remote = peerDoc.getText('content');
    Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(h.doc));
    const toPeer: Uint8Array[] = [];
    const toLocal: Uint8Array[] = [];
    h.doc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && toPeer.push(u));
    peerDoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && toLocal.push(u));
    const flush = () => {
      for (const u of toPeer.splice(0)) Y.applyUpdate(peerDoc, u, 'net');
      for (const u of toLocal.splice(0)) Y.applyUpdate(h.doc, u, 'net');
    };

    const markers: string[] = [];
    const insertLine = (s: string, tag: string) => {
      const at = pick(lineStarts(s));
      markers.push(tag);
      return { at, line: `${tag}\n` };
    };
    const fillerLine = (s: string) => {
      const starts = lineStarts(s).filter((i) => /^filler \d+\n/.test(s.slice(i, i + 12)));
      if (!starts.length) return undefined;
      const at = pick(starts);
      return { at, length: s.indexOf('\n', at) + 1 - at };
    };

    const log: string[] = [];
    for (let step = 0; step < 60; step++) {
      const r = random();
      log.push(`${step}:${r.toFixed(2)}`);
      const disk = platform.fs.snapshot()['n.md'] ?? '';
      if (r < 0.2) {
        const { at, line } = insertLine(local.toString(), `«L${step}»`);
        local.insert(at, line);
      } else if (r < 0.35) {
        const { at, line } = insertLine(remote.toString(), `«R${step}»`);
        remote.insert(at, line);
      } else if (r < 0.55) {
        const { at, line } = insertLine(disk, `«E${step}»`);
        platform.fs.external.write('n.md', disk.slice(0, at) + line + disk.slice(at));
      } else if (r < 0.62) {
        const del = fillerLine(local.toString());
        if (del) local.delete(del.at, del.length);
      } else if (r < 0.7) {
        const del = fillerLine(disk);
        if (del)
          platform.fs.external.write(
            'n.md',
            disk.slice(0, del.at) + disk.slice(del.at + del.length),
          );
      } else if (r < 0.85) {
        flush();
      } else {
        await settle();
      }
      if (random() < 0.3) await sleep();
      if (process.env.FUZZ_DEBUG) {
        const d = platform.fs.snapshot()['n.md'] ?? '';
        log.push(
          `  after ${step}: L=${local.toString().includes('«R18»')} R=${remote.toString().includes('«R18»')} D=${d.includes('«R18»')}`,
        );
      }
    }
    for (let i = 0; i < 4; i++) {
      flush();
      await settle();
    }
    await h.save();
    await settle();

    const files = platform.fs.snapshot();
    const final = local.toString();
    if (process.env.FUZZ_DEBUG)
      console.log(JSON.stringify({ final, files, markers, log }, null, 1));
    expect(files['n.md']).toBe(final);
    expect(remote.toString()).toBe(final);
    const copies = Object.entries(files)
      .filter(([p]) => p.includes('conflict'))
      .map(([, c]) => c)
      .join('\n');
    for (const m of markers) {
      const count = final.split(m).length - 1;
      expect(count, `${m} duplicated (seed ${seed})`).toBeLessThanOrEqual(1);
      if (count === 0) expect(copies, `${m} lost (seed ${seed})`).toContain(m);
    }
    return Object.keys(files).length - 1;
  }

  it('converges without losing edits', async () => {
    const only = Number(process.env.FUZZ_SEED);
    const seeds = only ? [only] : Array.from({ length: 80 }, (_, i) => i + 1);
    let conflicts = 0;
    for (const seed of seeds) conflicts += await run(seed);
    // ~12 racing external writes per run; conflict copies must stay the exception.
    expect(conflicts / seeds.length).toBeLessThan(2);
  }, 60_000);
});
