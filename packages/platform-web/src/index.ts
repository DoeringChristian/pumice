/**
 * Pumice in a browser: a vault kept in IndexedDB.
 *
 * Files and the app's own storage (the state of a shared vault) are in ONE database. A shared
 * vault takes a file that is missing for one that was deleted, and deletes it for everyone: the
 * two must never be lost apart, and a vault that cannot be read whole must not be opened.
 */
import {
  dirname,
  normalizePath,
  type AppStorage,
  type FileStat,
  type Platform,
  type PlatformFs,
  type PlatformOs,
  type SharedVaultSession,
  type VaultPath,
  type VaultSwitcher,
} from '@pumice/platform';

const STATS = 'stats';
const DATA = 'data';
const KEYS = 'keys';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const databaseName = (id: string) => `pumice-vault:${id}`;

function openDatabase(id: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName(id), 1);
    request.onupgradeneeded = () => {
      for (const store of [STATS, DATA, KEYS]) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The browser storage is blocked.'));
  });
}

const result = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Runs `work` in a transaction that is on disk when the promise resolves. */
function write(
  db: IDBDatabase,
  stores: string[],
  work: (tx: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('The browser could not save the change.'));
    work(tx);
  });
}

/** The files of a vault. What there is, is known in memory; contents are read when asked for. */
export class IdbFs implements PlatformFs {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly stats: Map<VaultPath, FileStat>,
  ) {}

  static async load(db: IDBDatabase): Promise<IdbFs> {
    const tx = db.transaction([STATS, DATA]);
    const [stats, contents] = await Promise.all([
      result(tx.objectStore(STATS).getAll() as IDBRequest<FileStat[]>),
      result(tx.objectStore(DATA).getAllKeys()),
    ]);
    const there = new Set(contents);
    if (stats.some((s) => s.kind === 'file' && !there.has(s.path)))
      throw new Error('This browser’s copy of the vault is damaged. Remove it and open it again.');
    return new IdbFs(db, new Map(stats.map((s) => [s.path, s])));
  }

  async list(): Promise<FileStat[]> {
    return [...this.stats.values()];
  }

  async stat(path: VaultPath): Promise<FileStat | null> {
    return this.stats.get(normalizePath(path)) ?? null;
  }

  async readText(path: VaultPath): Promise<string> {
    return decoder.decode(await this.readBinary(path));
  }

  async readBinary(path: VaultPath): Promise<Uint8Array> {
    const p = normalizePath(path);
    if (this.stats.get(p)?.kind !== 'file') throw new Error(`ENOENT: ${p}`);
    const data = await result(
      this.db.transaction(DATA).objectStore(DATA).get(p) as IDBRequest<Uint8Array | undefined>,
    );
    if (!data) throw new Error(`ENOENT: ${p}`);
    return data;
  }

  async write(path: VaultPath, data: string | Uint8Array): Promise<FileStat> {
    const p = normalizePath(path);
    if (!p || this.stats.get(p)?.kind === 'folder') throw new Error(`EISDIR: ${p}`);
    const folders = this.missingFolders(dirname(p));
    const bytes = typeof data === 'string' ? encoder.encode(data) : data.slice();
    // Two writes within a millisecond still differ.
    const mtime = Math.max(Date.now(), (this.stats.get(p)?.mtime ?? 0) + 1);
    const stat: FileStat = { path: p, kind: 'file', size: bytes.byteLength, mtime };
    await write(this.db, [STATS, DATA], (tx) => {
      for (const s of [...folders, stat]) tx.objectStore(STATS).put(s, s.path);
      tx.objectStore(DATA).put(bytes, p);
    });
    for (const s of [...folders, stat]) this.stats.set(s.path, s);
    return stat;
  }

  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    const a = normalizePath(from);
    const b = normalizePath(to);
    if (!this.stats.has(a)) throw new Error(`ENOENT: ${a}`);
    if (this.stats.has(b)) throw new Error(`EEXIST: ${b}`);
    if (b.startsWith(`${a}/`)) throw new Error(`EINVAL: ${b}`);
    const folders = this.missingFolders(dirname(b));
    const moved = this.tree(a).map((s) => ({ old: s, path: b + s.path.slice(a.length) }));
    await write(this.db, [STATS, DATA], (tx) => {
      const stats = tx.objectStore(STATS);
      const data = tx.objectStore(DATA);
      for (const s of folders) stats.put(s, s.path);
      for (const { old, path } of moved) {
        stats.delete(old.path);
        stats.put({ ...old, path }, path);
        if (old.kind !== 'file') continue;
        const request = data.get(old.path);
        request.onsuccess = () => {
          data.put(request.result, path);
          data.delete(old.path);
        };
      }
    });
    for (const s of folders) this.stats.set(s.path, s);
    for (const { old, path } of moved) {
      this.stats.delete(old.path);
      this.stats.set(path, { ...old, path });
    }
  }

  async remove(path: VaultPath): Promise<void> {
    const p = normalizePath(path);
    if (!this.stats.has(p)) throw new Error(`ENOENT: ${p}`);
    const gone = this.tree(p);
    await write(this.db, [STATS, DATA], (tx) => {
      for (const s of gone) {
        tx.objectStore(STATS).delete(s.path);
        tx.objectStore(DATA).delete(s.path);
      }
    });
    for (const s of gone) this.stats.delete(s.path);
  }

  async mkdir(path: VaultPath): Promise<void> {
    const folders = this.missingFolders(normalizePath(path));
    if (!folders.length) return;
    await write(this.db, [STATS], (tx) => {
      for (const s of folders) tx.objectStore(STATS).put(s, s.path);
    });
    for (const s of folders) this.stats.set(s.path, s);
  }

  private tree(path: VaultPath): FileStat[] {
    return [...this.stats.values()].filter((s) => s.path === path || s.path.startsWith(`${path}/`));
  }

  private missingFolders(path: VaultPath): FileStat[] {
    const out: FileStat[] = [];
    for (let p = path; p; p = dirname(p)) {
      const there = this.stats.get(p);
      if (there?.kind === 'file') throw new Error(`ENOTDIR: ${p}`);
      if (there) break;
      out.push({ path: p, kind: 'folder', size: 0, mtime: Date.now() });
    }
    return out;
  }
}

export class IdbStorage implements AppStorage {
  constructor(private readonly db: IDBDatabase) {}

  get(key: string): Promise<string | undefined> {
    return result(
      this.db.transaction(KEYS).objectStore(KEYS).get(key) as IDBRequest<string | undefined>,
    );
  }

  set(key: string, value: string): Promise<void> {
    return write(this.db, [KEYS], (tx) => void tx.objectStore(KEYS).put(value, key));
  }

  delete(key: string): Promise<void> {
    return write(this.db, [KEYS], (tx) => void tx.objectStore(KEYS).delete(key));
  }
}

/** The vault is open in another tab of this browser. */
export class VaultInUseError extends Error {
  constructor() {
    super('This vault is already open in another tab.');
  }
}

/**
 * Takes the vault for this tab until it is closed. What is in the vault is known in memory (see
 * `IdbFs`), so two tabs on one would each overwrite what the other does.
 */
async function takeVault(id: string): Promise<() => void> {
  if (!navigator.locks)
    throw new Error('Pumice needs a secure address (https) and a current browser.');
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(databaseName(id), { ifAvailable: true }, (lock) => {
        if (!lock) return reject(new VaultInUseError());
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}

export interface WebPlatformOptions {
  /** Names the vault's database. */
  id: string;
  name: string;
  vaults?: VaultSwitcher;
  /** A shared vault (docs/plan/10): the collaboration plugin keeps this copy in step. */
  shared?: SharedVaultSession;
}

export { withServedFolder } from './served-folder';

export function browserOs(): PlatformOs {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return 'android';
  if (/iPhone|iPad/.test(ua)) return 'ios';
  if (/Mac/.test(ua)) return navigator.maxTouchPoints > 1 ? 'ios' : 'macos';
  return /Win/.test(ua) ? 'windows' : 'linux';
}

export async function createWebPlatform(opts: WebPlatformOptions): Promise<Platform> {
  const release = await takeVault(opts.id);
  try {
    const db = await openDatabase(opts.id);
    // Deleted from another tab: let go, or the deletion waits for this tab.
    db.onversionchange = () => db.close();
    const fs = await IdbFs.load(db);
    // Not to be thrown away when the disk fills up; browsers may decline.
    void navigator.storage?.persist?.().catch(() => false);
    const pause = new Set<() => void>();
    const resume = new Set<() => void>();
    document.addEventListener('visibilitychange', () => {
      for (const l of document.visibilityState === 'hidden' ? pause : resume) l();
    });
    window.addEventListener('pagehide', () => pause.forEach((l) => l()));
    return {
      kind: 'web',
      os: browserOs(),
      vaultName: opts.name,
      fs,
      // Nothing but this tab changes the files: never anything to report.
      watcher: { watch: () => () => undefined },
      storage: new IdbStorage(db),
      lifecycle: {
        onPause: (l) => (pause.add(l), () => pause.delete(l)),
        onResume: (l) => (resume.add(l), () => resume.delete(l)),
      },
      shell: {
        openExternal: async (url) => {
          window.open(url, '_blank', 'noopener');
        },
      },
      ...(opts.vaults ? { vaults: opts.vaults } : {}),
      // A served folder: its agents speak of its files by their path on its server.
      ...(opts.shared?.folder ? { vaultRoot: opts.shared.folder } : {}),
      ...(opts.shared ? { shared: opts.shared } : {}),
    };
  } catch (e) {
    release();
    throw e;
  }
}

/** Deletes a vault's files and state from this browser. Fails while a tab has it open. */
export async function deleteWebVault(id: string): Promise<void> {
  const release = await takeVault(id);
  try {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName(id));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new VaultInUseError());
    });
  } finally {
    release();
  }
}
