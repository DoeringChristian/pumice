import { Emitter, type Event, type PlatformFs, type VaultPath } from '@pumice/api';

/** A rectangle in PDF page units (origin bottom-left, as in the PDF itself). */
export interface PdfRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PdfAnnotation {
  id: string;
  /** Page index, starting at 0. */
  page: number;
  color: string;
  /** The highlighted text. */
  text: string;
  rects: PdfRect[];
  note?: string;
  /** ISO timestamps. */
  created: string;
  updated?: string;
}

interface AnnotationsFile {
  version: 1;
  path: VaultPath;
  annotations: PdfAnnotation[];
}

export const ANNOTATIONS_DIR = '.pumice/annotations';

export const HIGHLIGHT_COLORS = [
  { name: 'Yellow', value: '#ffd43b' },
  { name: 'Green', value: '#8ce99a' },
  { name: 'Blue', value: '#74c0fc' },
  { name: 'Pink', value: '#faa2c1' },
  { name: 'Orange', value: '#ffa94d' },
];

/** A box in page coordinates with the origin at the top-left (as laid out on screen). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * One box per line of text: a selection yields a box per text run (often several per word),
 * which would overlap and draw unevenly.
 */
export function mergeBoxes(boxes: Box[]): Box[] {
  const sorted = boxes
    .filter((b) => b.right - b.left > 0.5 && b.bottom - b.top > 0.5)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Box[] = [];
  for (const box of sorted) {
    const height = box.bottom - box.top;
    const line = lines.find((l) => {
      const overlap = Math.min(l.bottom, box.bottom) - Math.max(l.top, box.top);
      const gap = Math.max(l.left, box.left) - Math.min(l.right, box.right);
      // Same line (mostly overlapping vertically) and touching or nearly so horizontally.
      return overlap > 0.5 * Math.min(height, l.bottom - l.top) && gap < height * 1.5;
    });
    if (line) {
      line.left = Math.min(line.left, box.left);
      line.right = Math.max(line.right, box.right);
      line.top = Math.min(line.top, box.top);
      line.bottom = Math.max(line.bottom, box.bottom);
    } else lines.push({ ...box });
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** Selected text as one paragraph (PDF text comes with a line break per printed line). */
export function tidyText(text: string): string {
  return (
    text
      // Control characters some PDFs carry in their text.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
  );
}

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Highlights written by the Obsidian plugin "PDF Annotator" (kept in a markdown file with a
 * json block, under `.pdf-annotator/bundles/sha256/<hash of the PDF>/annotation-sets/`).
 */
export function parseObsidianAnnotatorSet(markdown: string): PdfAnnotation[] {
  const block = /```json\n([\s\S]*?)\n```/.exec(markdown);
  if (!block) return [];
  let data: { highlights?: unknown };
  try {
    data = JSON.parse(block[1]!) as { highlights?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(data.highlights)) return [];
  const result: PdfAnnotation[] = [];
  for (const raw of data.highlights as Array<Record<string, unknown>>) {
    if (typeof raw.page !== 'number' || !Array.isArray(raw.rects)) continue;
    const rects = (raw.rects as Array<Record<string, unknown>>).filter(
      (r): r is Record<string, number> =>
        ['x1', 'y1', 'x2', 'y2'].every((k) => typeof r[k] === 'number'),
    );
    if (!rects.length) continue;
    result.push({
      id: typeof raw.id === 'string' ? raw.id : newId(),
      page: raw.page,
      color: typeof raw.color === 'string' ? raw.color : HIGHLIGHT_COLORS[0]!.value,
      text: tidyText(typeof raw.text === 'string' ? raw.text : ''),
      rects: rects.map((r) => ({ x1: r.x1!, y1: r.y1!, x2: r.x2!, y2: r.y2! })),
      ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
      created: typeof raw.created === 'string' ? raw.created : new Date().toISOString(),
    });
  }
  return result;
}

export interface StoreDeps {
  fs: PlatformFs;
}

/**
 * Annotations per PDF, in `.pumice/annotations/<pdf path>.json`. The file follows the PDF when
 * it is renamed or moved in the app.
 */
export class AnnotationStore {
  private readonly cache = new Map<VaultPath, AnnotationsFile>();
  private readonly changed = new Emitter<VaultPath>();
  readonly onDidChange: Event<VaultPath> = this.changed.event;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: StoreDeps) {}

  dispose(): void {
    this.changed.dispose();
  }

  private fileOf(path: VaultPath): VaultPath {
    return `${ANNOTATIONS_DIR}/${path}.json`;
  }

  /** Whether this PDF has no annotations file of its own yet. */
  async isNew(path: VaultPath): Promise<boolean> {
    return !this.cache.has(path) && !(await this.deps.fs.stat(this.fileOf(path)));
  }

  private async load(path: VaultPath): Promise<AnnotationsFile> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    let file: AnnotationsFile = { version: 1, path, annotations: [] };
    try {
      if (await this.deps.fs.stat(this.fileOf(path))) {
        const parsed = JSON.parse(
          await this.deps.fs.readText(this.fileOf(path)),
        ) as AnnotationsFile;
        if (Array.isArray(parsed.annotations)) file = { ...parsed, path };
      }
    } catch {
      // Unreadable file: start empty; it is left alone until the next change.
    }
    this.cache.set(path, file);
    return file;
  }

  /** Annotations in reading order. */
  async list(path: VaultPath): Promise<PdfAnnotation[]> {
    const file = await this.load(path);
    const top = (a: PdfAnnotation) => Math.max(...a.rects.map((r) => Math.max(r.y1, r.y2)));
    return [...file.annotations].sort((a, b) => a.page - b.page || top(b) - top(a));
  }

  /**
   * Highlights made with the Obsidian "PDF Annotator" plugin for the PDF with this SHA-256.
   * They are only read; that plugin's files are never changed.
   */
  async readObsidianAnnotations(sha256: string): Promise<PdfAnnotation[]> {
    const dir = `.pdf-annotator/bundles/sha256/${sha256}/annotation-sets`;
    let sets = ['default'];
    try {
      if (!(await this.deps.fs.stat(dir))) return [];
      const index = JSON.parse(await this.deps.fs.readText(`${dir}/index.json`)) as {
        sets?: Array<{ id?: unknown }>;
      };
      const ids = (index.sets ?? []).flatMap((s) => (typeof s.id === 'string' ? [s.id] : []));
      if (ids.length) sets = ids;
    } catch {
      // No index: try the default set.
    }
    const result: PdfAnnotation[] = [];
    for (const set of sets) {
      try {
        result.push(...parseObsidianAnnotatorSet(await this.deps.fs.readText(`${dir}/${set}.md`)));
      } catch {
        // Missing set.
      }
    }
    return result;
  }

  /** Takes over annotations found elsewhere for a PDF that has none here yet. */
  import(path: VaultPath, annotations: PdfAnnotation[]): Promise<void> {
    return this.mutate(path, (file) => {
      const known = new Set(file.annotations.map((a) => a.id));
      file.annotations.push(...annotations.filter((a) => !known.has(a.id)));
    });
  }

  add(
    path: VaultPath,
    annotation: Pick<PdfAnnotation, 'page' | 'color' | 'text' | 'rects'> & { note?: string },
  ): Promise<PdfAnnotation> {
    return this.mutate(path, (file) => {
      const a: PdfAnnotation = { id: newId(), ...annotation, created: new Date().toISOString() };
      file.annotations.push(a);
      return a;
    });
  }

  update(path: VaultPath, id: string, patch: { color?: string; note?: string }): Promise<void> {
    return this.mutate(path, (file) => {
      const a = file.annotations.find((x) => x.id === id);
      if (!a) return;
      if (patch.color !== undefined) a.color = patch.color;
      if (patch.note !== undefined) {
        if (patch.note.trim()) a.note = patch.note;
        else delete a.note;
      }
      a.updated = new Date().toISOString();
    });
  }

  remove(path: VaultPath, id: string): Promise<void> {
    return this.mutate(path, (file) => {
      file.annotations = file.annotations.filter((a) => a.id !== id);
    });
  }

  /** A PDF (or folder) was renamed: move its annotations along. */
  async moved(oldPath: VaultPath, newPath: VaultPath, kind: 'file' | 'folder'): Promise<void> {
    const from = kind === 'file' ? this.fileOf(oldPath) : `${ANNOTATIONS_DIR}/${oldPath}`;
    const to = kind === 'file' ? this.fileOf(newPath) : `${ANNOTATIONS_DIR}/${newPath}`;
    const run = async () => {
      this.cache.clear();
      try {
        if (await this.deps.fs.stat(from)) await this.deps.fs.rename(from, to);
      } catch {
        // The annotations stay under the old path; nothing else is lost.
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    await next;
  }

  /** Serializes read-modify-write cycles. */
  private mutate<T>(path: VaultPath, fn: (file: AnnotationsFile) => T): Promise<T> {
    const run = async () => {
      const file = await this.load(path);
      const before = JSON.stringify(file.annotations);
      const result = fn(file);
      if (JSON.stringify(file.annotations) === before) return result;
      if (file.annotations.length) {
        await this.deps.fs.write(this.fileOf(path), `${JSON.stringify(file, null, 2)}\n`);
      } else if (await this.deps.fs.stat(this.fileOf(path))) {
        await this.deps.fs.remove(this.fileOf(path));
      }
      this.changed.fire(path);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
