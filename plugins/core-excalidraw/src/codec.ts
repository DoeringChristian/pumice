/**
 * Drawing ↔ Y.Doc (docs/plan/06):
 *   Y.Text "head"      frontmatter + preamble, verbatim
 *   Y.Map  "elements"  elementId → element (plain JSON, replaced as a whole)
 *   Y.Map  "files"     fileId → Excalidraw binary file entry (pasted images not in the vault)
 *   Y.Map  "embedded"  fileId → `[[link]]` of a vault image
 *   Y.Map  "meta"      shared appState subset and scene header
 *   Y.Map  "file"      format details and the text as loaded (for byte-identical saves)
 * Concurrent edits merge per element: the higher `version` wins, ties go to the lower
 * `versionNonce` — Excalidraw's own reconciliation rule.
 */
import type { DocumentCodec } from '@pumice/api';
import * as Y from 'yjs';
import {
  parseDrawing,
  serializeDrawing,
  type DrawingElement,
  type ParsedDrawing,
  type Scene,
} from './format';

/** appState keys that belong to the drawing rather than to one user's view. */
const SHARED_APP_STATE = [
  'viewBackgroundColor',
  'gridSize',
  'gridStep',
  'gridModeEnabled',
  'frameRendering',
];

export const ORIGIN_DRAWING_LOAD = 'pumice:excalidraw-load';

export function elementsMap(doc: Y.Doc): Y.Map<DrawingElement> {
  return doc.getMap<DrawingElement>('elements');
}

/** Whether `incoming` should replace `current` (Excalidraw's reconciliation rule). */
export function wins(incoming: DrawingElement, current: DrawingElement | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return (
    incoming.versionNonce < current.versionNonce && incoming.versionNonce !== current.versionNonce
  );
}

function sceneHash(doc: Y.Doc): string {
  // Cheap fingerprint of everything that serializes.
  const elements = [...elementsMap(doc).values()]
    .map((e) => `${e.id}:${e.version}:${e.versionNonce}:${e.isDeleted ? 1 : 0}`)
    .sort();
  return JSON.stringify([
    doc.getText('head').toString(),
    elements,
    doc.getMap('embedded').toJSON(),
    doc.getMap('files').toJSON(),
    doc.getMap('meta').toJSON(),
  ]);
}

export function readDrawing(doc: Y.Doc): ParsedDrawing {
  const file = doc.getMap<unknown>('file');
  const meta = doc.getMap<unknown>('meta').toJSON() as Record<string, unknown>;
  const { sceneType, sceneVersion, sceneSource, ...appState } = meta;
  const scene: Scene = {
    type: (sceneType as string) ?? 'excalidraw',
    version: (sceneVersion as number) ?? 2,
    source: (sceneSource as string) ?? 'https://pumice.app',
    elements: [...elementsMap(doc).values()],
    appState,
    files: doc.getMap('files').toJSON(),
  };
  return {
    format: (file.get('format') as 'md' | 'json') ?? 'md',
    head: doc.getText('head').toString(),
    scene,
    embedded: doc.getMap<string>('embedded').toJSON() as Record<string, string>,
    extraSections: (file.get('extraSections') as string[]) ?? [],
    compressed: (file.get('compressed') as boolean) ?? true,
  };
}

/** Writes a parsed drawing into the doc, changing only what differs. */
export function applyDrawing(doc: Y.Doc, drawing: ParsedDrawing, base?: ParsedDrawing): void {
  doc.transact(() => {
    const head = doc.getText('head');
    if (head.toString() !== drawing.head) {
      head.delete(0, head.length);
      head.insert(0, drawing.head);
    }
    const elements = elementsMap(doc);
    const incoming = new Map(drawing.scene.elements.map((e) => [e.id, e]));
    for (const [id, el] of incoming) if (wins(el, elements.get(id))) elements.set(id, el);
    if (base) {
      // Removed on the other side and untouched here since the base: remove.
      const baseIds = new Map(base.scene.elements.map((e) => [e.id, e]));
      for (const [id, el] of baseIds) {
        const local = elements.get(id);
        if (!incoming.has(id) && local && local.version === el.version) elements.delete(id);
      }
    }
    const embedded = doc.getMap<string>('embedded');
    for (const [id, link] of Object.entries(drawing.embedded))
      if (embedded.get(id) !== link) embedded.set(id, link);
    const files = doc.getMap<unknown>('files');
    for (const [id, f] of Object.entries(drawing.scene.files)) if (!files.has(id)) files.set(id, f);
    const meta = doc.getMap<unknown>('meta');
    const shared: Record<string, unknown> = {
      sceneType: drawing.scene.type,
      sceneVersion: drawing.scene.version,
      sceneSource: drawing.scene.source,
    };
    for (const key of SHARED_APP_STATE)
      if (key in drawing.scene.appState) shared[key] = drawing.scene.appState[key];
    for (const [k, v] of Object.entries(shared))
      if (JSON.stringify(meta.get(k)) !== JSON.stringify(v)) meta.set(k, v);
    const file = doc.getMap<unknown>('file');
    file.set('format', drawing.format);
    file.set('compressed', drawing.compressed);
    file.set('extraSections', drawing.extraSections);
  }, ORIGIN_DRAWING_LOAD);
}

export function excalidrawCodec(): DocumentCodec {
  /** Text as loaded/merged, with its fingerprint: unchanged drawings save byte-identical. */
  const loaded = new WeakMap<Y.Doc, { text: string; hash: string }>();
  return {
    id: 'excalidraw',
    extensions: ['excalidraw.md', 'excalidraw'],
    load(doc, content, path) {
      const drawing = parseDrawing(path, content);
      applyDrawing(doc, drawing);
      loaded.set(doc, { text: content, hash: sceneHash(doc) });
    },
    serialize(doc) {
      const original = loaded.get(doc);
      if (original && original.hash === sceneHash(doc)) return original.text;
      return serializeDrawing(readDrawing(doc));
    },
    mergeExternal(doc, base, theirs, path) {
      let incoming: ParsedDrawing;
      let baseDrawing: ParsedDrawing | undefined;
      try {
        incoming = parseDrawing(path, theirs);
        baseDrawing = base ? parseDrawing(path, base) : undefined;
      } catch {
        return false; // unreadable: keep ours, save theirs as a conflict copy
      }
      applyDrawing(doc, incoming, baseDrawing);
      if (sceneHash(doc) === hashOf(incoming))
        loaded.set(doc, { text: theirs, hash: sceneHash(doc) });
      return true;
    },
  };

  function hashOf(drawing: ParsedDrawing): string {
    const tmp = new Y.Doc();
    applyDrawing(tmp, drawing);
    const h = sceneHash(tmp);
    tmp.destroy();
    return h;
  }
}
