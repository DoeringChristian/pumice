/**
 * Serving a folder as a shared vault (`pumice-server <folder>`): the server takes part in the
 * vault like any other device, with the folder as its copy. What is written into the folder
 * (by hand, by a program, by an agent) reaches everyone; what they edit is written into it.
 *
 * It is the app's own sync (core.collab's SharedVault), connected to this server, on the folder.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type {
  AppStorage,
  FileStat,
  FsWatchEvent,
  Platform,
  PlatformFs,
  PlatformWatcher,
  VaultPath,
} from '@pumice/platform';
import { CollabClient } from '@pumice/core-collab/client';
import { SharedVault } from '@pumice/core-collab/shared-vault';
import { DocumentsImpl, markdownCodec } from '@pumice/core-documents';
import { excalidrawCodec } from '@pumice/core-excalidraw/codec';
import { MetadataIndexImpl, inlineParser } from '@pumice/core-index';
import { MarkdownSyntaxImpl } from '@pumice/core-markdown';
import { VaultImpl } from '@pumice/core-vault';
import type { Store } from './db.ts';

/** Dot-files and dot-folders (`.git`, `.pumice-server`, `.trash`) are not part of the vault. */
const hidden = (path: VaultPath) => path.split('/').some((s) => s.startsWith('.'));

/** The folder, as the app's platform sees a vault folder (as on the desktop). */
class FolderFs implements PlatformFs, PlatformWatcher {
  constructor(readonly root: string) {}

  /**
   * A path in the vault as a path on disk; nothing outside the folder. A symbolic link on the
   * way is refused too: through one, others could read or write outside the folder.
   */
  private async abs(path: VaultPath): Promise<string> {
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new Error(`Path escapes the vault: ${path}`);
    let at = this.root;
    for (const part of relative(this.root, full).split(sep).filter(Boolean)) {
      at = join(at, part);
      const s = await fs.lstat(at).catch(() => undefined);
      if (!s) break;
      if (s.isSymbolicLink()) throw new Error(`Not followed (a symbolic link): ${path}`);
    }
    return full;
  }

  async list(): Promise<FileStat[]> {
    const out: FileStat[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        const path = relative(this.root, full).split(sep).join('/');
        if (e.isDirectory()) {
          out.push({ path, kind: 'folder', size: 0, mtime: 0 });
          await walk(full);
        } else if (e.isFile()) {
          const s = await fs.stat(full);
          out.push({ path, kind: 'file', size: s.size, mtime: Math.round(s.mtimeMs) });
        }
      }
    };
    await walk(this.root);
    return out;
  }

  async stat(path: VaultPath): Promise<FileStat | null> {
    try {
      const s = await fs.stat(await this.abs(path));
      return {
        path,
        kind: s.isDirectory() ? 'folder' : 'file',
        size: s.isDirectory() ? 0 : s.size,
        mtime: Math.round(s.mtimeMs),
      };
    } catch {
      return null;
    }
  }

  async readText(path: VaultPath): Promise<string> {
    return fs.readFile(await this.abs(path), 'utf8');
  }

  async readBinary(path: VaultPath): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(await this.abs(path)));
  }

  async write(path: VaultPath, data: string | Uint8Array): Promise<FileStat> {
    const full = await this.abs(path);
    await fs.mkdir(dirname(full), { recursive: true });
    // Whole or not at all: a hidden file beside it, renamed over it.
    const tmp = join(dirname(full), `.${basename(full)}.${randomUUID().slice(0, 8)}.tmp`);
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, full);
    return (await this.stat(path))!;
  }

  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    const target = await this.abs(to);
    const source = await this.abs(from);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.rename(source, target);
  }

  /** What others delete goes into the folder's `.trash` (as in Obsidian), not away for good. */
  async remove(path: VaultPath, opts?: { trash?: boolean }): Promise<void> {
    const full = await this.abs(path);
    if (full === this.root) throw new Error('Refusing to delete the vault root');
    if (!opts?.trash) return fs.rm(full, { recursive: true });
    let trashed = `.trash/${path}`;
    for (let n = 2; await this.exists(await this.abs(trashed)); n++)
      trashed = `.trash/${path} (${n})`;
    const target = await this.abs(trashed);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.rename(full, target);
  }

  private async exists(full: string): Promise<boolean> {
    return fs.stat(full).then(
      () => true,
      () => false,
    );
  }

  async mkdir(path: VaultPath): Promise<void> {
    await fs.mkdir(await this.abs(path), { recursive: true });
  }

  watch(listener: (events: FsWatchEvent[]) => void): () => void {
    const pending = new Set<VaultPath>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      const paths = [...pending];
      pending.clear();
      const events = await Promise.all(
        paths.map(async (path): Promise<FsWatchEvent> => ({
          path,
          type: (await this.stat(path)) ? 'modify' : 'delete',
        })),
      );
      listener(events);
    };
    let watcher: FSWatcher;
    try {
      watcher = watch(this.root, { recursive: true }, (_event, name) => {
        if (!name) return;
        const path = name.toString().split(sep).join('/');
        if (hidden(path)) return;
        pending.add(path);
        clearTimeout(timer);
        timer = setTimeout(() => void flush(), 60);
      });
    } catch (e) {
      console.error('[pumice-server] cannot watch the folder; changes on disk are not seen', e);
      return () => undefined;
    }
    return () => {
      watcher.close();
      clearTimeout(timer);
    };
  }
}

/** Key/value storage of the folder's copy (the vault's state as last synced), in a folder. */
function folderStorage(dir: string): AppStorage {
  const file = (key: string) =>
    join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.txt`);
  return {
    get: (key) => fs.readFile(file(key), 'utf8').catch(() => undefined),
    set: async (key, value) => {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file(key)}.${randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, value);
      await fs.rename(tmp, file(key));
    },
    delete: (key) => fs.rm(file(key), { force: true }),
  };
}

export interface ServedFolder {
  vaultId: string;
  /** The folder's name, as the vault's. */
  name: string;
  /** The folder (its real path). */
  root: string;
  /** What opens the vault, in its link (agents in the folder too). */
  key: string;
  /** The folder as the app sees a vault: its files, and its notes as documents. */
  fs: PlatformFs;
  vault: VaultImpl;
  documents: DocumentsImpl;
  /** Its notes' names, links and text, for the assistants' search (kept in memory). */
  index: MetadataIndexImpl;
  close(): Promise<void>;
}

interface FolderState {
  vaultId: string;
  userId: string;
  token: string;
  key?: string;
  /** (Earlier: a key per role; the owner's is the key now.) */
  keys?: { owner: string };
}

const newKey = () => randomBytes(24).toString('base64url');

/**
 * Serves `root` as a shared vault of the server at `url`: made from the folder the first time,
 * kept in step with it after (while the server was down too: it catches up on start).
 */
export async function serveFolder(opts: {
  root: string;
  dataDir: string;
  store: Store;
  /** Where the server listens, for the folder's own connection. */
  url: string;
}): Promise<ServedFolder> {
  const { store } = opts;
  // (Its real path: the check against links above starts from it.)
  const root = await fs.realpath(resolve(opts.root));
  const name = basename(root);
  const stateFile = join(opts.dataDir, 'folder.json');
  await fs.chmod(stateFile, 0o600).catch(() => undefined);
  let state = JSON.parse(
    await fs.readFile(stateFile, 'utf8').catch(() => 'null'),
  ) as FolderState | null;
  // The folder's own account: the vault's owner, under the folder's name.
  let user = state ? store.userForToken(state.token) : undefined;
  const fresh = !state || !user || !store.vaultsOf(user.id).some((v) => v.id === state!.vaultId);
  if (fresh) {
    const email = `folder-${randomUUID().slice(0, 8)}@pumice.local`;
    user = store.createUser(email, name);
    const vault = store.createVault(name, user.id);
    state = { vaultId: vault.id, userId: user.id, token: store.createSession(user.id, 'folder') };
  }
  if (fresh || !state!.key) {
    // The key in the link: long and random, kept only here (and in the browsers given it).
    const { keys, ...rest } = state!;
    state = { ...rest, key: (!fresh && keys?.owner) || newKey() };
    await fs.mkdir(opts.dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  // The folder's sign-in (it owns the vault) and the server's data: for this user's eyes only.
  await fs.chmod(opts.dataDir, 0o700);
  await fs.chmod(stateFile, 0o600);
  const { vaultId, token, key } = state as Required<FolderState>;

  const folder = new FolderFs(root);
  const platform: Platform = {
    kind: 'desktop',
    os:
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    vaultName: name,
    vaultRoot: root,
    fs: folder,
    watcher: folder,
    storage: folderStorage(join(opts.dataDir, 'folder')),
    lifecycle: { onPause: () => () => undefined, onResume: () => () => undefined },
    shell: { openExternal: async () => undefined },
  };
  const vault = new VaultImpl(platform);
  await vault.load();
  const documents = new DocumentsImpl(vault);
  documents.registerCodec(markdownCodec);
  documents.registerCodec(excalidrawCodec());

  const client = new CollabClient(opts.url, token);
  const shared = new SharedVault({
    client,
    vaultId,
    user: user!,
    role: 'owner',
    vault,
    documents,
    storage: platform.storage,
    notify: (message) => console.log(`[pumice-server] ${message}`),
  });
  documents.registerProvider(shared.provider());
  // (Its own connection lost: what the folder gets is not shared until it is back.)
  client.onDidChangeState((state) => {
    if (state === 'offline') console.log(`[pumice-server] ${name}: not connected, trying again`);
  });
  client.connect();
  // The folder is where the vault's files are: what is in it on start belongs to the vault (also
  // what was added while the server was down, when the vault was still empty).
  await shared.start({ seedFromDisk: true });
  const syntax = new MarkdownSyntaxImpl();
  const index = new MetadataIndexImpl({
    vault,
    documents,
    parser: inlineParser((text) => syntax.extract(text)),
  });
  // (Read in the background: a large folder takes a while; search finds what is read so far.)
  void index.start().catch((e) => console.error('[pumice-server] could not index the folder', e));

  return {
    vaultId,
    name,
    key,
    root,
    fs: folder,
    vault,
    documents,
    index,
    close: async () => {
      index.dispose();
      await shared.idle();
      await shared.flush();
      shared.dispose();
      client.dispose();
      documents.dispose();
      vault.dispose();
    },
  };
}
