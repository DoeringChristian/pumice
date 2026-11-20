import {
  dirname,
  normalizePath,
  type AppStorage,
  type FileStat,
  type FsWatchEvent,
  type Platform,
  type PlatformFs,
  type PlatformKind,
  type PlatformOs,
  type PlatformWatcher,
  type VaultPath,
} from '@pumice/platform';

interface Node {
  kind: 'file' | 'folder';
  data?: Uint8Array;
  mtime: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * In-memory vault for tests and the browser demo. `external` simulates edits made by
 * other programs: they bypass nothing but are reported through the watcher.
 */
export class MemoryFs implements PlatformFs, PlatformWatcher {
  private nodes = new Map<VaultPath, Node>();
  private listeners = new Set<(events: FsWatchEvent[]) => void>();
  private clock = 1_700_000_000_000;

  constructor(files: Record<string, string | Uint8Array> = {}) {
    for (const [path, content] of Object.entries(files)) this.put(normalizePath(path), content);
  }

  /** Simulates a change made outside the app (another editor, sync tool, git). */
  readonly external = {
    write: (path: string, content: string | Uint8Array) => {
      const p = normalizePath(path);
      const existed = this.nodes.has(p);
      this.put(p, content);
      this.emit([{ type: existed ? 'modify' : 'create', path: p }]);
    },
    remove: (path: string) => {
      const p = normalizePath(path);
      const removed = this.removeTree(p);
      this.emit(removed.map((path) => ({ type: 'delete' as const, path })));
    },
    rename: (from: string, to: string) => {
      const events = this.moveTree(normalizePath(from), normalizePath(to));
      this.emit(events);
    },
  };

  watch(listener: (events: FsWatchEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(): Promise<FileStat[]> {
    return [...this.nodes.entries()].map(([path, node]) => this.toStat(path, node));
  }

  async stat(path: VaultPath): Promise<FileStat | null> {
    const node = this.nodes.get(normalizePath(path));
    return node ? this.toStat(normalizePath(path), node) : null;
  }

  async readText(path: VaultPath): Promise<string> {
    return decoder.decode(this.file(path).data);
  }

  async readBinary(path: VaultPath): Promise<Uint8Array> {
    return this.file(path).data!.slice();
  }

  async write(path: VaultPath, data: string | Uint8Array): Promise<FileStat> {
    const p = normalizePath(path);
    if (this.nodes.get(p)?.kind === 'folder') throw new Error(`EISDIR: ${p}`);
    this.put(p, data);
    return this.toStat(p, this.nodes.get(p)!);
  }

  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    this.moveTree(normalizePath(from), normalizePath(to));
  }

  async remove(path: VaultPath): Promise<void> {
    const p = normalizePath(path);
    if (!this.nodes.has(p)) throw new Error(`ENOENT: ${p}`);
    this.removeTree(p);
  }

  async mkdir(path: VaultPath): Promise<void> {
    this.ensureFolder(normalizePath(path));
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, node] of this.nodes)
      if (node.kind === 'file') out[path] = decoder.decode(node.data);
    return out;
  }

  private put(path: VaultPath, content: string | Uint8Array): void {
    this.ensureFolder(dirname(path));
    this.nodes.set(path, {
      kind: 'file',
      data: typeof content === 'string' ? encoder.encode(content) : content.slice(),
      mtime: this.tick(),
    });
  }

  private ensureFolder(path: VaultPath): void {
    if (path === '') return;
    const existing = this.nodes.get(path);
    if (existing?.kind === 'file') throw new Error(`ENOTDIR: ${path}`);
    if (existing) return;
    this.ensureFolder(dirname(path));
    this.nodes.set(path, { kind: 'folder', mtime: this.tick() });
  }

  private file(path: VaultPath): Node {
    const node = this.nodes.get(normalizePath(path));
    if (!node || node.kind !== 'file') throw new Error(`ENOENT: ${path}`);
    return node;
  }

  private removeTree(path: VaultPath): VaultPath[] {
    const removed: VaultPath[] = [];
    for (const p of [...this.nodes.keys()]) {
      if (p === path || p.startsWith(path + '/')) {
        this.nodes.delete(p);
        removed.push(p);
      }
    }
    return removed;
  }

  private moveTree(from: VaultPath, to: VaultPath): FsWatchEvent[] {
    if (!this.nodes.has(from)) throw new Error(`ENOENT: ${from}`);
    if (this.nodes.has(to)) throw new Error(`EEXIST: ${to}`);
    this.ensureFolder(dirname(to));
    const events: FsWatchEvent[] = [];
    for (const [p, node] of [...this.nodes.entries()]) {
      if (p === from || p.startsWith(from + '/')) {
        const target = to + p.slice(from.length);
        this.nodes.delete(p);
        this.nodes.set(target, node);
        events.push({ type: 'delete', path: p }, { type: 'create', path: target });
      }
    }
    return events;
  }

  private toStat(path: VaultPath, node: Node): FileStat {
    return { path, kind: node.kind, size: node.data?.byteLength ?? 0, mtime: node.mtime };
  }

  private tick(): number {
    return ++this.clock;
  }

  private emit(events: FsWatchEvent[]): void {
    if (events.length === 0) return;
    for (const l of [...this.listeners]) l(events);
  }
}

export class MemoryStorage implements AppStorage {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key);
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

export interface MemoryPlatformOptions {
  files?: Record<string, string | Uint8Array>;
  kind?: PlatformKind;
  os?: PlatformOs;
  vaultName?: string;
}

export function createMemoryPlatform(
  opts: MemoryPlatformOptions = {},
): Platform & { fs: MemoryFs } {
  const fs = new MemoryFs(opts.files);
  const pause = new Set<() => void>();
  const resume = new Set<() => void>();
  return {
    kind: opts.kind ?? 'web',
    os: opts.os ?? 'unknown',
    vaultName: opts.vaultName ?? 'Demo vault',
    fs,
    watcher: fs,
    storage: new MemoryStorage(),
    lifecycle: {
      onPause: (l) => (pause.add(l), () => pause.delete(l)),
      onResume: (l) => (resume.add(l), () => resume.delete(l)),
    },
    shell: {
      openExternal: async (url) => {
        if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
      },
    },
  };
}
