import {
  Emitter,
  basename,
  dirname,
  joinPath,
  normalizePath,
  type VaultApi,
  type VaultChange,
  type VaultEntry,
  type VaultFile,
  type VaultFolder,
  type VaultPath,
} from '@pumice/api';
import type { FileStat, FsWatchEvent, Platform } from '@pumice/platform';

/** Dot-folders and dot-files (`.pumice`, `.git`, `.obsidian`, `.DS_Store`) are not part of the tree. */
export function isIgnored(path: VaultPath): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

function toEntry(stat: FileStat): VaultEntry {
  const name = basename(stat.path);
  if (stat.kind === 'folder') return { kind: 'folder', path: stat.path, name };
  const dot = name.lastIndexOf('.');
  return {
    kind: 'file',
    path: stat.path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    size: stat.size,
    mtime: stat.mtime,
  };
}

function sameStat(entry: VaultEntry | undefined, stat: FileStat): boolean {
  if (!entry || entry.kind !== stat.kind) return false;
  return entry.kind === 'folder' || (entry.size === stat.size && entry.mtime === stat.mtime);
}

export class VaultImpl implements VaultApi {
  private entries = new Map<VaultPath, VaultEntry>();
  private readonly changed = new Emitter<VaultChange[]>();
  readonly onDidChange = this.changed.event;
  private unwatch?: () => void;
  /** Serializes watcher batches so stats are applied in order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly platform: Platform) {}

  get name(): string {
    return this.platform.vaultName;
  }

  async load(): Promise<void> {
    this.entries.clear();
    for (const stat of await this.platform.fs.list()) {
      if (!isIgnored(stat.path)) this.entries.set(stat.path, toEntry(stat));
    }
    this.unwatch = this.platform.watcher?.watch((events) => {
      this.queue = this.queue.then(() => this.applyExternal(events)).catch((e) => console.error(e));
    });
  }

  dispose(): void {
    this.unwatch?.();
    this.changed.dispose();
  }

  /** Resolves once all pending watcher batches are applied (for tests). */
  settled(): Promise<void> {
    return this.queue;
  }

  get(path: VaultPath): VaultEntry | undefined {
    const p = normalizePath(path);
    if (p === '') return { kind: 'folder', path: '', name: this.name };
    return this.entries.get(p);
  }

  files(): VaultFile[] {
    return [...this.entries.values()].filter((e): e is VaultFile => e.kind === 'file');
  }

  folders(): VaultFolder[] {
    return [...this.entries.values()].filter((e): e is VaultFolder => e.kind === 'folder');
  }

  children(folder: VaultPath): VaultEntry[] {
    const parent = normalizePath(folder);
    return [...this.entries.values()]
      .filter((e) => dirname(e.path) === parent)
      .sort((a, b) =>
        a.kind !== b.kind
          ? a.kind === 'folder'
            ? -1
            : 1
          : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      );
  }

  read(path: VaultPath): Promise<string> {
    return this.platform.fs.readText(normalizePath(path));
  }

  readBinary(path: VaultPath): Promise<Uint8Array> {
    return this.platform.fs.readBinary(normalizePath(path));
  }

  async readRange(
    path: VaultPath,
    offset: number,
    length: number,
  ): Promise<Uint8Array | undefined> {
    return this.platform.fs.readRange?.(normalizePath(path), offset, length);
  }

  async create(path: VaultPath, content: string | Uint8Array): Promise<VaultFile> {
    const p = this.checkPath(path);
    if (this.entries.has(p) || (await this.platform.fs.stat(p)))
      throw new Error(`'${p}' already exists`);
    return this.write(p, content);
  }

  async write(path: VaultPath, content: string | Uint8Array): Promise<VaultFile> {
    const p = this.checkPath(path);
    const existed = this.entries.has(p);
    const changes: VaultChange[] = this.addMissingParents(p);
    const stat = await this.platform.fs.write(p, content);
    const entry = toEntry(stat) as VaultFile;
    this.entries.set(p, entry);
    changes.push(
      existed
        ? { type: 'modify', entry, external: false }
        : { type: 'create', entry, external: false },
    );
    this.changed.fire(changes);
    return entry;
  }

  async createFolder(path: VaultPath): Promise<VaultFolder> {
    const p = this.checkPath(path);
    await this.platform.fs.mkdir(p);
    const changes = this.addMissingParents(joinPath(p, '_'));
    this.changed.fire(changes);
    return this.entries.get(p) as VaultFolder;
  }

  async rename(from: VaultPath, to: VaultPath): Promise<VaultEntry> {
    const src = normalizePath(from);
    const dst = this.checkPath(to);
    const entry = this.entries.get(src);
    if (!entry) throw new Error(`'${src}' does not exist`);
    if (src === dst) return entry;
    if (this.entries.has(dst) && src.toLowerCase() !== dst.toLowerCase())
      throw new Error(`'${dst}' already exists`);
    const changes = this.addMissingParents(dst);
    await this.platform.fs.rename(src, dst);
    for (const [p, e] of [...this.entries]) {
      if (p !== src && !p.startsWith(src + '/')) continue;
      this.entries.delete(p);
      const renamed = toEntry({
        path: dst + p.slice(src.length),
        kind: e.kind,
        size: e.kind === 'file' ? e.size : 0,
        mtime: e.kind === 'file' ? e.mtime : 0,
      });
      this.entries.set(renamed.path, renamed);
      changes.push({ type: 'rename', oldPath: p, entry: renamed, external: false });
    }
    this.changed.fire(changes);
    return this.entries.get(dst)!;
  }

  async delete(path: VaultPath): Promise<void> {
    const p = normalizePath(path);
    const entry = this.entries.get(p);
    if (!entry) throw new Error(`'${p}' does not exist`);
    await this.platform.fs.remove(p, { trash: true });
    this.changed.fire(this.removeTree(p, false));
  }

  availablePath(folder: VaultPath, base: string, extension: string): VaultPath {
    const ext = extension ? `.${extension}` : '';
    for (let i = 0; ; i++) {
      const candidate = joinPath(folder, `${base}${i === 0 ? '' : ` ${i}`}${ext}`);
      if (!this.entries.has(candidate)) return candidate;
    }
  }

  async rescan(): Promise<void> {
    await this.queue;
    const stats = (await this.platform.fs.list()).filter((s) => !isIgnored(s.path));
    const seen = new Set(stats.map((s) => s.path));
    const changes: VaultChange[] = [];
    for (const path of [...this.entries.keys()]) {
      if (!seen.has(path) && this.entries.has(path)) changes.push(...this.removeTree(path, true));
    }
    for (const stat of stats.sort((a, b) => a.path.length - b.path.length)) {
      changes.push(...this.upsert(stat));
    }
    if (changes.length) this.changed.fire(changes);
  }

  private async applyExternal(events: FsWatchEvent[]): Promise<void> {
    const changes: VaultChange[] = [];
    const paths = [...new Set(events.map((e) => normalizePath(e.path)))].filter(
      (p) => !isIgnored(p),
    );
    for (const path of paths) {
      const stat = await this.platform.fs.stat(path);
      if (!stat) {
        if (this.entries.has(path)) changes.push(...this.removeTree(path, true));
        continue;
      }
      // Our own writes come back from the watcher with an unchanged stat: ignored here.
      changes.push(...this.upsert(stat));
    }
    if (changes.length) this.changed.fire(changes);
  }

  private upsert(stat: FileStat): VaultChange[] {
    const existing = this.entries.get(stat.path);
    if (sameStat(existing, stat)) return [];
    const changes = this.addMissingParents(stat.path, true);
    if (existing && existing.kind !== stat.kind) changes.push(...this.removeTree(stat.path, true));
    const entry = toEntry(stat);
    const isNew = !this.entries.has(stat.path);
    this.entries.set(stat.path, entry);
    if (isNew) changes.push({ type: 'create', entry, external: true });
    else if (entry.kind === 'file') changes.push({ type: 'modify', entry, external: true });
    return changes;
  }

  private removeTree(path: VaultPath, external: boolean): VaultChange[] {
    const changes: VaultChange[] = [];
    // Children first, so listeners see a consistent tree at every step.
    const doomed = [...this.entries.values()]
      .filter((e) => e.path === path || e.path.startsWith(path + '/'))
      .sort((a, b) => b.path.length - a.path.length);
    for (const e of doomed) {
      this.entries.delete(e.path);
      changes.push({ type: 'delete', path: e.path, kind: e.kind, external });
    }
    return changes;
  }

  private addMissingParents(path: VaultPath, external = false): VaultChange[] {
    const changes: VaultChange[] = [];
    const parents: VaultPath[] = [];
    for (let dir = dirname(path); dir !== ''; dir = dirname(dir)) parents.unshift(dir);
    for (const dir of parents) {
      if (this.entries.has(dir)) continue;
      const entry: VaultFolder = { kind: 'folder', path: dir, name: basename(dir) };
      this.entries.set(dir, entry);
      changes.push({ type: 'create', entry, external });
    }
    return changes;
  }

  private checkPath(path: VaultPath): VaultPath {
    const p = normalizePath(path);
    if (p === '') throw new Error('Path must not be empty');
    if (isIgnored(p)) throw new Error(`'${p}' is inside a hidden folder`);
    if (/[\\:*?"<>|]/.test(basename(p)))
      throw new Error(`'${basename(p)}' contains characters not allowed in file names`);
    return p;
  }
}
