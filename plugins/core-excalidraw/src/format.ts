/**
 * Reading and writing drawings: Obsidian Excalidraw's `.excalidraw.md` and plain `.excalidraw`
 * JSON. Pure functions (no Excalidraw library needed), so they also run in the indexer.
 */
import LZString from 'lz-string';

/** The parts of an Excalidraw element we rely on; everything else is carried along untouched. */
export interface DrawingElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  index?: string | null;
  text?: string;
  originalText?: string;
  link?: string | null;
  fileId?: string | null;
  [key: string]: unknown;
}

export interface Scene {
  type: string;
  version: number;
  source: string;
  elements: DrawingElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export interface ParsedDrawing {
  format: 'md' | 'json';
  /** Everything before `# Excalidraw Data` (frontmatter and the warning line), verbatim. */
  head: string;
  scene: Scene;
  /** `fileId → [[link]]` from the Embedded Files section (vault images). */
  embedded: Record<string, string>;
  /** Unknown `##` sections of the data part, kept verbatim. */
  extraSections: string[];
  compressed: boolean;
}

const DATA_HEADING = /^# Excalidraw Data[ \t]*$/m;
const DRAWING_BLOCK = /```(compressed-json|json)\r?\n([\s\S]*?)\r?\n```/;

export const DEFAULT_HEAD = `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'

`;

export function emptyScene(): Scene {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://pumice.app',
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

export function isDrawingPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.excalidraw.md') || lower.endsWith('.excalidraw');
}

function decompress(data: string): string {
  const text = LZString.decompressFromBase64(data.replace(/\s+/g, ''));
  if (!text) throw new Error('Could not decompress the drawing data');
  return text;
}

/** Compresses like the Obsidian plugin: base64 LZ-string, wrapped every 256 characters. */
export function compress(json: string): string {
  const data = LZString.compressToBase64(json);
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 256) lines.push(data.slice(i, i + 256));
  return lines.join('\n\n');
}

function normalizeScene(raw: unknown): Scene {
  const s = (raw ?? {}) as Partial<Scene>;
  return {
    type: s.type ?? 'excalidraw',
    version: s.version ?? 2,
    source: s.source ?? 'https://pumice.app',
    elements: Array.isArray(s.elements) ? s.elements : [],
    appState: s.appState ?? {},
    files: s.files ?? {},
  };
}

/** The pictures of the vault in a plain drawing: `"embeddedFiles": { fileId: "[[a.png]]" }`. */
function embeddedOf(raw: unknown): Record<string, string> {
  const files = (raw as { embeddedFiles?: unknown } | undefined)?.embeddedFiles;
  if (!files || typeof files !== 'object') return {};
  return Object.fromEntries(
    Object.entries(files).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

export function parseDrawing(path: string, text: string): ParsedDrawing {
  if (!path.toLowerCase().endsWith('.md')) {
    const raw: unknown = text.trim() ? JSON.parse(text) : undefined;
    return {
      format: 'json',
      head: '',
      scene: raw ? normalizeScene(raw) : emptyScene(),
      embedded: embeddedOf(raw),
      extraSections: [],
      compressed: false,
    };
  }
  const dataAt = text.search(DATA_HEADING);
  // Older plugin versions had no "# Excalidraw Data" heading: the head ends at "# Text Elements".
  const legacyAt = dataAt < 0 ? text.search(/^# Text Elements[ \t]*$/m) : -1;
  const headEnd = dataAt >= 0 ? dataAt : legacyAt >= 0 ? legacyAt : text.search(/^%%[ \t]*$/m);
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const block = DRAWING_BLOCK.exec(text);
  let scene = emptyScene();
  let compressed = true;
  if (block) {
    compressed = block[1] === 'compressed-json';
    scene = normalizeScene(JSON.parse(compressed ? decompress(block[2]!) : block[2]!));
  }
  const embedded: Record<string, string> = {};
  const extraSections: string[] = [];
  if (headEnd >= 0) {
    const data = text.slice(headEnd);
    const sections = data.split(/^(?=## )/m);
    for (const section of sections) {
      const title = /^## (.+)$/m.exec(section)?.[1]?.trim();
      if (!title || !section.startsWith('## ')) continue;
      if (title === 'Embedded Files') {
        for (const m of section.matchAll(/^([0-9a-f]{20,64}): (.+)$/gm))
          embedded[m[1]!] = m[2]!.trim();
      } else if (!['Text Elements', 'Element Links', 'Drawing'].includes(title)) {
        // Strip the trailing `%%` that opens the drawing comment.
        extraSections.push(section.replace(/\n%%\s*$/, '\n').trimEnd());
      }
    }
  }
  return { format: 'md', head, scene, embedded, extraSections, compressed };
}

/** Elements in drawing order (fractional `index`, falling back to array order). */
export function orderElements(elements: DrawingElement[]): DrawingElement[] {
  return elements
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const x = a.e.index ?? null;
      const y = b.e.index ?? null;
      if (x !== null && y !== null && x !== y) return x < y ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ e }) => e);
}

export function serializeDrawing(drawing: ParsedDrawing): string {
  const scene: Scene = { ...drawing.scene, elements: orderElements(drawing.scene.elements) };
  if (drawing.format === 'json') {
    // Pictures of the vault are referred to, not copied (other programs ignore the entry).
    const embeddedFiles = Object.keys(drawing.embedded).length
      ? { embeddedFiles: drawing.embedded }
      : {};
    return `${JSON.stringify({ ...scene, ...embeddedFiles }, null, 2)}\n`;
  }
  const live = scene.elements.filter((e) => !e.isDeleted);
  const texts = live.filter((e) => e.type === 'text');
  const links = live.filter((e) => e.link && e.type !== 'text');
  let out = drawing.head || DEFAULT_HEAD;
  if (!out.endsWith('\n')) out += '\n';
  out += '# Excalidraw Data\n\n## Text Elements\n';
  for (const t of texts)
    out += `${(t.originalText ?? t.text ?? '').replace(/\n/g, ' ')} ^${t.id}\n\n`;
  if (links.length) {
    out += '## Element Links\n';
    for (const e of links) out += `${e.id}: ${e.link}\n\n`;
  }
  const embedded = Object.entries(drawing.embedded);
  if (embedded.length) {
    out += '## Embedded Files\n';
    for (const [id, link] of embedded) out += `${id}: ${link}\n\n`;
  }
  for (const section of drawing.extraSections) out += `${section}\n\n`;
  const json = JSON.stringify({ ...scene, files: drawing.compressed ? {} : scene.files });
  out += '%%\n## Drawing\n';
  out += drawing.compressed
    ? `\`\`\`compressed-json\n${compress(json)}\n\`\`\`\n`
    : `\`\`\`json\n${JSON.stringify(scene, null, 2)}\n\`\`\`\n`;
  out += '%%';
  return out;
}

/** Visible text of a drawing (for search and previews). */
export function drawingText(scene: Scene): string {
  return orderElements(scene.elements)
    .filter((e) => !e.isDeleted && e.type === 'text')
    .map((e) => e.originalText ?? e.text ?? '')
    .join('\n');
}

/** The text of a new drawing: plain, unless its name asks for Obsidian's format. */
export function newDrawing(path = 'drawing.excalidraw'): string {
  const md = path.toLowerCase().endsWith('.md');
  return serializeDrawing({
    format: md ? 'md' : 'json',
    head: md ? DEFAULT_HEAD : '',
    scene: emptyScene(),
    embedded: {},
    extraSections: [],
    compressed: md,
  });
}
