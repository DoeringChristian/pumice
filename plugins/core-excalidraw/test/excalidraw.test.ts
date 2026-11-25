import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { elementsMap, excalidrawCodec } from '../src/codec';
import { drawingMetadata } from '../src/extract';
import {
  compress,
  drawingText,
  newDrawing,
  parseDrawing,
  serializeDrawing,
  type DrawingElement,
} from '../src/format';

const el = (id: string, extra: Partial<DrawingElement> = {}): DrawingElement => ({
  id,
  type: 'rectangle',
  version: 1,
  versionNonce: 100,
  index: `a${id}`,
  x: 0,
  y: 0,
  ...extra,
});

/** A file in the layout written by the Obsidian Excalidraw plugin (2.x). */
function obsidianFile(elements: DrawingElement[]): string {
  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.5.0',
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  };
  return `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'


# Excalidraw Data

## Text Elements
Hello [[Note]] ^t1

## Embedded Files
0123456789abcdef0123456789abcdef01234567: [[pic.png]]

%%
## Drawing
\`\`\`compressed-json
${compress(JSON.stringify(scene))}
\`\`\`
%%`;
}

describe('format', () => {
  const text = obsidianFile([
    el('r1'),
    el('t1', { type: 'text', text: 'Hello [[Note]]', originalText: 'Hello [[Note]]' }),
  ]);

  it('parses the Obsidian layout', () => {
    const d = parseDrawing('a.excalidraw.md', text);
    expect(d.format).toBe('md');
    expect(d.compressed).toBe(true);
    expect(d.scene.elements.map((e) => e.id)).toEqual(['r1', 't1']);
    expect(d.embedded).toEqual({ '0123456789abcdef0123456789abcdef01234567': '[[pic.png]]' });
    expect(d.head.startsWith('---\n\nexcalidraw-plugin: parsed')).toBe(true);
    expect(drawingText(d.scene)).toBe('Hello [[Note]]');
  });

  it('serialize → parse is stable', () => {
    const d = parseDrawing('a.excalidraw.md', text);
    const again = parseDrawing('a.excalidraw.md', serializeDrawing(d));
    expect(again.scene.elements).toEqual(d.scene.elements);
    expect(again.embedded).toEqual(d.embedded);
    expect(again.head).toBe(d.head);
    expect(serializeDrawing(again)).toBe(serializeDrawing(d));
  });

  it('plain .excalidraw JSON and uncompressed md', () => {
    const json = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'x',
      elements: [el('a')],
      appState: {},
      files: {},
    });
    expect(parseDrawing('b.excalidraw', json).scene.elements[0]!.id).toBe('a');
    const d = { ...parseDrawing('a.excalidraw.md', text), compressed: false };
    const plain = serializeDrawing(d);
    expect(plain).toContain('```json\n');
    expect(parseDrawing('a.excalidraw.md', plain).scene.elements).toHaveLength(2);
  });

  it('a plain drawing keeps its pictures of the vault', () => {
    const d = { ...parseDrawing('n.excalidraw', newDrawing()), embedded: { abc: '[[pic.png]]' } };
    const again = parseDrawing('n.excalidraw', serializeDrawing(d));
    expect(again.embedded).toEqual({ abc: '[[pic.png]]' });
    expect(drawingMetadata('n.excalidraw', serializeDrawing(d), () => ({}) as never).links).toEqual(
      [expect.objectContaining({ kind: 'embed', target: 'pic.png' })],
    );
    expect(parseDrawing('o.excalidraw', '{"embeddedFiles":[1]}').embedded).toEqual({});
  });

  it('new drawings are empty and parse back', () => {
    const plain = parseDrawing('n.excalidraw', newDrawing());
    expect(plain.format).toBe('json');
    expect(plain.scene.elements).toEqual([]);
    const d = parseDrawing('n.excalidraw.md', newDrawing('n.excalidraw.md'));
    expect(d.head).toContain('excalidraw-plugin: parsed');
    expect(d.scene.elements).toEqual([]);
  });
});

describe('codec', () => {
  const codec = excalidrawCodec();
  const path = 'd.excalidraw.md';
  const text = obsidianFile([el('r1'), el('r2')]);

  it('saves unchanged drawings byte-identical', () => {
    const doc = new Y.Doc();
    codec.load(doc, text, path);
    expect(codec.serialize(doc, path)).toBe(text);
    elementsMap(doc).set('r3', el('r3'));
    const changed = codec.serialize(doc, path);
    expect(changed).not.toBe(text);
    expect(parseDrawing(path, changed).scene.elements.map((e) => e.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('merges external edits element by element', () => {
    const doc = new Y.Doc();
    codec.load(doc, text, path);
    // Local: move r1. External: edit r2, delete nothing, add r9.
    elementsMap(doc).set('r1', el('r1', { version: 2, x: 50 }));
    const theirs = obsidianFile([el('r1'), el('r2', { version: 3, y: 99 }), el('r9')]);
    expect(codec.mergeExternal(doc, text, theirs, path)).toBe(true);
    const map = elementsMap(doc);
    expect(map.get('r1')!.x).toBe(50);
    expect(map.get('r2')!.y).toBe(99);
    expect(map.has('r9')).toBe(true);
    // External deletion of an element we didn't touch removes it.
    const before = obsidianFile([el('r1'), el('r2', { version: 3, y: 99 }), el('r9')]);
    expect(
      codec.mergeExternal(
        doc,
        before,
        obsidianFile([el('r1'), el('r2', { version: 3, y: 99 })]),
        path,
      ),
    ).toBe(true);
    expect(map.has('r9')).toBe(false);
    expect(map.get('r1')!.x).toBe(50);
  });

  it('concurrent Y.Doc replicas converge', () => {
    const a = new Y.Doc();
    codec.load(a, text, path);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    elementsMap(a).set('r1', el('r1', { version: 5, x: 1 }));
    elementsMap(b).set('r2', el('r2', { version: 5, x: 2 }));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(codec.serialize(a, path)).toBe(codec.serialize(b, path));
    expect(elementsMap(a).get('r1')!.x).toBe(1);
    expect(elementsMap(a).get('r2')!.x).toBe(2);
  });
});
