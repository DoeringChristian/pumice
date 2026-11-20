import {
  formatWikiLink,
  generateId,
  isNoteId,
  setProperty,
  type DocumentsApi,
  type IndexedFile,
  type LinkFormatOptions,
  type MetadataIndexApi,
  type NoteIdsApi,
  type VaultPath,
} from '@pumice/api';
import { editNote } from '@pumice/core-links';

const idOfFile = (file: IndexedFile | undefined): string | undefined => {
  const id = file?.meta?.frontmatter?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
};

/**
 * The ID ↔ note table, kept from the index's frontmatter data. IDs resolve links through the
 * index's resolver hook; everything else in the app works without them.
 */
export class NoteIdTable implements NoteIdsApi {
  private readonly byId = new Map<string, Set<VaultPath>>();
  private readonly byPath = new Map<VaultPath, string>();
  /** IDs handed out but maybe not yet visible in the index. */
  private readonly reserved = new Map<VaultPath, string>();
  private readonly writes = new Map<VaultPath, Promise<string>>();

  constructor(
    private readonly index: MetadataIndexApi,
    private readonly documents: DocumentsApi,
  ) {}

  /** Re-reads the IDs of `paths` (all files when omitted). Returns whether anything changed. */
  refresh(paths?: VaultPath[]): boolean {
    let changed = false;
    const update = (path: VaultPath) => {
      const next = idOfFile(this.index.getFile(path));
      const prev = this.byPath.get(path);
      if (next === prev) return;
      changed = true;
      if (prev) {
        const set = this.byId.get(prev);
        set?.delete(path);
        if (set && !set.size) this.byId.delete(prev);
        this.byPath.delete(path);
      }
      if (next) {
        this.byPath.set(path, next);
        const set = this.byId.get(next) ?? new Set();
        set.add(path);
        this.byId.set(next, set);
      }
    };
    if (paths) paths.forEach(update);
    else {
      const all = new Set([...this.byPath.keys(), ...this.index.files().map((f) => f.path)]);
      all.forEach(update);
    }
    return changed;
  }

  idOf(path: VaultPath): string | undefined {
    return this.byPath.get(path) ?? this.reserved.get(path);
  }

  /** The note with this ID (see `ranked` for duplicates). */
  pathOf(id: string): VaultPath | undefined {
    const paths = this.byId.get(id);
    if (!paths?.size) {
      for (const [path, reservedId] of this.reserved) if (reservedId === id) return path;
      return undefined;
    }
    return this.ranked(paths)[0];
  }

  /**
   * Which note keeps a duplicated ID: the one higher up in the folder tree, then the one
   * changed longest ago (copies are usually newer), then alphabetical order.
   */
  private ranked(paths: Iterable<VaultPath>): VaultPath[] {
    const depth = (p: VaultPath) => p.split('/').length;
    const mtime = (p: VaultPath) => this.index.getFile(p)?.mtime ?? 0;
    return [...paths].sort(
      (a, b) => depth(a) - depth(b) || mtime(a) - mtime(b) || (a < b ? -1 : 1),
    );
  }

  /** IDs claimed by more than one note. */
  duplicates(): Array<[string, VaultPath[]]> {
    return [...this.byId.entries()]
      .filter(([, paths]) => paths.size > 1)
      .map(([id, paths]) => [id, this.ranked(paths)]);
  }

  resolve = (target: string): VaultPath | undefined =>
    isNoteId(target) ? this.pathOf(target) : undefined;

  freshId(): string {
    for (;;) {
      const id = generateId();
      if (!this.byId.has(id) && ![...this.reserved.values()].includes(id)) return id;
    }
  }

  /** The note's ID right away; a new one is written to the note in the background. */
  idFor(path: VaultPath): string {
    const existing = this.idOf(path);
    if (existing) return existing;
    const id = this.freshId();
    this.reserved.set(path, id);
    void this.writeId(path, id);
    return id;
  }

  async ensureId(path: VaultPath): Promise<string> {
    const id = this.idFor(path);
    await this.writes.get(path);
    return id;
  }

  /** Gives a note a new ID (for duplicates). */
  async reassign(path: VaultPath): Promise<string> {
    const id = this.freshId();
    this.reserved.set(path, id);
    return this.writeId(path, id);
  }

  private writeId(path: VaultPath, id: string): Promise<string> {
    const write = editNote(this.documents, path, (text) => {
      const change = setProperty(text, 'id', id);
      return change ? [change] : null;
    })
      .then(() => id)
      .finally(() => {
        this.writes.delete(path);
        // Keep the reservation until the index has caught up.
        setTimeout(() => {
          if (this.byPath.get(path) === id) this.reserved.delete(path);
        }, 2000);
      });
    this.writes.set(path, write);
    return write;
  }

  /** `[[id|Title]]` for a note (assigning an ID if needed); undefined for other files. */
  formatLink(file: IndexedFile, opts: LinkFormatOptions): string | undefined {
    if (!/\.md$/i.test(file.path) || /\.excalidraw\.md$/i.test(file.path)) return undefined;
    const display =
      opts.alias ??
      (opts.subpath ? `${file.title} › ${opts.subpath.replace(/^\^/, '')}` : file.title);
    return formatWikiLink(
      {
        target: this.idFor(file.path),
        ...(opts.subpath ? { subpath: opts.subpath } : {}),
        alias: display,
      },
      { embed: !!opts.embed, inTable: !!opts.inTable },
    );
  }
}
