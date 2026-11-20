import { describe, expect, it } from 'vitest';
import type { PlatformFs } from '@pumice/api';
import {
  AnnotationStore,
  mergeBoxes,
  parseObsidianAnnotatorSet,
  tidyText,
} from '../src/annotations';

function memoryFs(
  files: Record<string, string> = {},
): PlatformFs & { files: Record<string, string> } {
  const stat = (path: string) => ({ path, kind: 'file' as const, size: 0, mtime: 0 });
  return {
    files,
    stat: async (path: string) =>
      path in files || Object.keys(files).some((f) => f.startsWith(`${path}/`)) ? stat(path) : null,
    readText: async (path: string) => {
      if (!(path in files)) throw new Error('missing');
      return files[path]!;
    },
    write: async (path: string, data: string | Uint8Array) => {
      files[path] = String(data);
      return stat(path);
    },
    rename: async (from: string, to: string) => {
      for (const key of Object.keys(files)) {
        if (key === from || key.startsWith(`${from}/`)) {
          files[to + key.slice(from.length)] = files[key]!;
          delete files[key];
        }
      }
    },
    remove: async (path: string) => {
      delete files[path];
    },
  } as unknown as PlatformFs & { files: Record<string, string> };
}

describe('mergeBoxes', () => {
  it('joins the runs of a line and keeps lines apart', () => {
    const merged = mergeBoxes([
      { left: 10, top: 100, right: 40, bottom: 112 },
      { left: 10, top: 101, right: 40, bottom: 111 }, // the same run reported twice
      { left: 42, top: 100, right: 90, bottom: 112 },
      { left: 10, top: 116, right: 60, bottom: 128 },
    ]);
    expect(merged).toEqual([
      { left: 10, top: 100, right: 90, bottom: 112 },
      { left: 10, top: 116, right: 60, bottom: 128 },
    ]);
  });

  it('keeps two columns on the same height apart', () => {
    const merged = mergeBoxes([
      { left: 10, top: 100, right: 100, bottom: 112 },
      { left: 300, top: 100, right: 400, bottom: 112 },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('tidyText', () => {
  it('joins printed lines and drops control characters', () => {
    expect(tidyText('one \u0002two\u0003\n  three')).toBe('one two three');
  });
});

const OBSIDIAN_SET = `---
lpa-annotations: 1
---
- **p.1** text

\`\`\`json
{ "version": 1, "highlights": [
  { "id": "4fff462f", "type": "highlight", "page": 0, "color": "#FBF719",
    "text": "a \\u0002b\\u0003", "rects": [{ "x1": 1, "y1": 20, "x2": 5, "y2": 10 }],
    "created": "2026-09-08T18:04:32.315Z", "note": "Nice" },
  { "id": "bad", "page": 0, "rects": [] }
] }
\`\`\`
`;

describe('parseObsidianAnnotatorSet', () => {
  it('reads highlights with their notes', () => {
    expect(parseObsidianAnnotatorSet(OBSIDIAN_SET)).toEqual([
      {
        id: '4fff462f',
        page: 0,
        color: '#FBF719',
        text: 'a b',
        rects: [{ x1: 1, y1: 20, x2: 5, y2: 10 }],
        note: 'Nice',
        created: '2026-09-08T18:04:32.315Z',
      },
    ]);
  });
  it('returns nothing for other files', () => {
    expect(parseObsidianAnnotatorSet('# hello')).toEqual([]);
  });
});

describe('AnnotationStore', () => {
  const rect = { x1: 0, y1: 10, x2: 5, y2: 0 };

  it('saves, updates and removes annotations', async () => {
    const fs = memoryFs();
    const store = new AnnotationStore({ fs });
    const a = await store.add('papers/a.pdf', { page: 2, color: '#fff', text: 'x', rects: [rect] });
    await store.add('papers/a.pdf', { page: 0, color: '#fff', text: 'first', rects: [rect] });
    expect((await store.list('papers/a.pdf')).map((x) => x.text)).toEqual(['first', 'x']);
    await store.update('papers/a.pdf', a.id, { note: 'why' });
    const saved = JSON.parse(fs.files['.pumice/annotations/papers/a.pdf.json']!);
    expect(saved.annotations[0].note).toBe('why');

    // A second store (the app restarted) reads the same file.
    const again = new AnnotationStore({ fs });
    expect(await again.list('papers/a.pdf')).toHaveLength(2);

    for (const x of await store.list('papers/a.pdf')) await store.remove('papers/a.pdf', x.id);
    expect(fs.files['.pumice/annotations/papers/a.pdf.json']).toBeUndefined();
  });

  it('follows a renamed PDF and a renamed folder', async () => {
    const fs = memoryFs();
    const store = new AnnotationStore({ fs });
    await store.add('papers/a.pdf', { page: 0, color: '#fff', text: 'x', rects: [rect] });
    await store.moved('papers/a.pdf', 'papers/b.pdf', 'file');
    expect(await store.list('papers/b.pdf')).toHaveLength(1);
    await store.moved('papers', 'read', 'folder');
    expect(await store.list('read/b.pdf')).toHaveLength(1);
    expect(await store.list('papers/a.pdf')).toHaveLength(0);
  });

  it('reads the Obsidian PDF Annotator highlights without touching them', async () => {
    const dir = '.pdf-annotator/bundles/sha256/abc/annotation-sets';
    const fs = memoryFs({
      [`${dir}/index.json`]: JSON.stringify({ sets: [{ id: 'default' }] }),
      [`${dir}/default.md`]: OBSIDIAN_SET,
    });
    const before = JSON.stringify(fs.files);
    const store = new AnnotationStore({ fs });
    expect(await store.isNew('a.pdf')).toBe(true);
    const found = await store.readObsidianAnnotations('abc');
    expect(found).toHaveLength(1);
    expect(await store.readObsidianAnnotations('other')).toEqual([]);
    expect(JSON.stringify(fs.files)).toBe(before);
    await store.import('a.pdf', found);
    await store.import('a.pdf', found);
    expect(await store.list('a.pdf')).toHaveLength(1);
    expect(await store.isNew('a.pdf')).toBe(false);
  });
});
