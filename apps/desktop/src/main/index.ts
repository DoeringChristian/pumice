import type { FileStat, FsWatchEvent, PlatformOs } from '@pumice/platform';
import { IPC } from '@pumice/platform-electron/host';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChatGptError, createChatGpt, type ChatGpt } from './chatgpt';
import { FrameServer } from './frames';
import { ProcessManager } from './processes';

const OS: PlatformOs =
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';

/**
 * The renderer is served from `app://pumice/` rather than `file://`: `fetch()` can't read file
 * URLs (Excalidraw loads its fonts that way), and a real origin keeps the CSP's 'self' precise.
 */
const APP_ORIGIN = 'app://pumice';
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
      // Frames (sandboxed, so another origin) fetch their own files from this scheme.
      corsEnabled: true,
    },
  },
]);

const frames = new FrameServer();

function serveRenderer(): void {
  const root = resolve(__dirname, '../renderer');
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (FrameServer.isFrameHost(url.host)) {
      return frames.respond(request, (owner, path) => {
        const session = sessions.get(owner);
        if (!session) throw new Error('The window of this frame is closed');
        return session.abs(path);
      });
    }
    const file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (url.host !== 'pumice' || (file !== root && !file.startsWith(root + sep)))
      return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
}

const configPath = () => join(app.getPath('userData'), 'config.json');

interface AppConfig {
  lastVault?: string;
  /** Vaults opened before, most recent first. */
  recent?: Array<{ path: string; opened: number }>;
}

const MAX_RECENT = 15;

async function rememberVault(root: string): Promise<void> {
  const config = await readConfig();
  const recent = [
    { path: root, opened: Date.now() },
    ...(config.recent ?? []).filter((v) => v.path !== root),
  ].slice(0, MAX_RECENT);
  await writeConfig({ ...config, lastVault: root, recent });
  buildMenu(recent.map((v) => v.path));
  if (OS !== 'linux') app.addRecentDocument(root);
}

async function knownVaults(current: string) {
  const config = await readConfig();
  const out = [];
  for (const v of config.recent ?? []) {
    // Folders that are gone (unplugged drive, deleted) stay listed but can't be opened.
    out.push({
      id: v.path,
      name: basename(v.path),
      location: v.path,
      current: v.path === current,
      lastOpened: v.opened,
    });
  }
  return out;
}

/** Opens a vault in a new window, or in place of `replace` (the old window closes after). */
async function switchVault(root: string, replace?: BrowserWindow): Promise<void> {
  const existing = [...sessions.values()].find((s) => s.root === root);
  if (existing) {
    existing.window.focus();
    return;
  }
  if (!(await fs.stat(root).catch(() => null))?.isDirectory())
    throw new Error(`The folder ${root} is not available.`);
  await openVault(root);
  replace?.close();
}

async function readConfig(): Promise<AppConfig> {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8')) as AppConfig;
  } catch {
    return {};
  }
}

async function writeConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2));
}

/** One open vault: a folder on disk, the window showing it and its watcher. */
class VaultSession {
  private watcher: FSWatcher | undefined;
  private pending = new Map<string, FsWatchEvent['type']>();
  private flushTimer: NodeJS.Timeout | undefined;
  readonly id: string;

  readonly processes: ProcessManager;

  constructor(
    readonly root: string,
    readonly window: BrowserWindow,
  ) {
    this.id = createHash('sha256').update(root).digest('hex').slice(0, 16);
    this.processes = new ProcessManager(root, window);
  }

  /** Maps a vault-relative path to an absolute one, refusing anything outside the vault. */
  abs(path: unknown): string {
    if (typeof path !== 'string') throw new Error('Path must be a string');
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new Error(`Path escapes the vault: ${path}`);
    return full;
  }

  rel(full: string): string {
    return relative(this.root, full).split(sep).join('/');
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await fs.stat(this.abs(path));
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

  async list(): Promise<FileStat[]> {
    const out: FileStat[] = [];
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      await Promise.all(
        entries.map(async (e) => {
          const full = join(dir, e.name);
          const path = this.rel(full);
          if (e.isDirectory()) {
            out.push({ path, kind: 'folder', size: 0, mtime: 0 });
            // Don't descend into hidden folders except the config folder.
            if (!e.name.startsWith('.') || e.name === '.pumice') await walk(full);
          } else if (e.isFile()) {
            const s = await fs.stat(full);
            out.push({ path, kind: 'file', size: s.size, mtime: Math.round(s.mtimeMs) });
          }
        }),
      );
    };
    await walk(this.root);
    return out;
  }

  async write(path: string, data: string | Uint8Array): Promise<FileStat> {
    const full = this.abs(path);
    await fs.mkdir(dirname(full), { recursive: true });
    // Atomic: write a hidden temp file next to the target, then rename over it.
    const tmp = join(dirname(full), `.${basename(full)}.${randomUUID().slice(0, 8)}.tmp`);
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, full);
    return (await this.stat(path))!;
  }

  startWatching(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const path = filename.toString().split(sep).join('/');
        if (path.split('/').some((s) => s.startsWith('.') && s !== '.pumice')) return;
        this.pending.set(path, 'modify');
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => void this.flushEvents(), 60);
      });
    } catch (e) {
      console.error('[pumice] file watching unavailable', e);
    }
  }

  private async flushEvents(): Promise<void> {
    const paths = [...this.pending.keys()];
    this.pending.clear();
    const events: FsWatchEvent[] = await Promise.all(
      paths.map(
        async (path) =>
          ({ path, type: (await this.stat(path)) ? 'modify' : 'delete' }) as FsWatchEvent,
      ),
    );
    if (!this.window.isDestroyed()) this.window.webContents.send(IPC.watch, events);
  }

  dispose(): void {
    this.processes.dispose();
    this.watcher?.close();
    clearTimeout(this.flushTimer);
  }
}

const sessions = new Map<number, VaultSession>();

function sessionFor(event: Electron.IpcMainInvokeEvent): VaultSession {
  const session = sessions.get(event.sender.id);
  if (!session) throw new Error('No vault open in this window');
  return session;
}

async function storageDir(session: VaultSession): Promise<string> {
  const dir = join(app.getPath('userData'), 'vaults', session.id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const storageFile = (dir: string, key: unknown) => {
  if (typeof key !== 'string') throw new Error('Key must be a string');
  return join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.txt`);
};

// Sign in with ChatGPT: one sign-in for the whole app, tokens in the user data folder.
let chatgptInstance: ChatGpt | undefined;
const chatgpt = () =>
  (chatgptInstance ??= createChatGpt({
    dataDir: app.getPath('userData'),
    openExternal: (url) => shell.openExternal(url),
  }));
/** Streams in flight, by window and request id. */
const chatgptStreams = new Map<string, AbortController>();
/** "Sign in again" survives IPC as a marker in the message (see platform-electron). */
const signInAware = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ChatGptError && e.reauth) throw new Error(`[sign-in] ${e.message}`);
    throw e;
  }
};

type Handler = (session: VaultSession, ...args: unknown[]) => unknown;

const handlers: Record<string, Handler> = {
  info: (s) => ({ vaultName: basename(s.root), vaultPath: s.root, os: OS, vaultId: s.id }),
  'fs.list': (s) => s.list(),
  'fs.stat': (s, p) => s.stat(String(p)),
  'fs.readText': (s, p) => fs.readFile(s.abs(p), 'utf8'),
  'fs.readBinary': async (s, p) => new Uint8Array(await fs.readFile(s.abs(p))),
  'fs.write': (s, p, data) => {
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('Invalid data');
    return s.write(String(p), data);
  },
  'fs.rename': async (s, from, to) => {
    const target = s.abs(to);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.rename(s.abs(from), target);
  },
  'fs.remove': async (s, p, trash) => {
    const full = s.abs(p);
    if (full === s.root) throw new Error('Refusing to delete the vault root');
    if (trash) await shell.trashItem(full);
    else await fs.rm(full, { recursive: true });
  },
  'fs.mkdir': (s, p) => fs.mkdir(s.abs(p), { recursive: true }),
  'storage.get': async (s, key) => {
    try {
      return await fs.readFile(storageFile(await storageDir(s), key), 'utf8');
    } catch {
      return undefined;
    }
  },
  'storage.set': async (s, key, value) =>
    fs.writeFile(storageFile(await storageDir(s), key), String(value)),
  'storage.delete': async (s, key) => fs.rm(storageFile(await storageDir(s), key), { force: true }),
  'shell.openExternal': (_s, url) => {
    // Only web and mail links leave the app.
    if (typeof url !== 'string' || !/^(https?|mailto):/i.test(url))
      throw new Error('Unsupported URL');
    return shell.openExternal(url);
  },
  'shell.reveal': (s, p) => shell.showItemInFolder(s.abs(p)),
  'vaults.list': (s) => knownVaults(s.root),
  'vaults.open': async (s, path, newWindow) => {
    // The renderer can only reopen folders the user picked before.
    const known = (await readConfig()).recent?.some((v) => v.path === path);
    if (typeof path !== 'string' || !known) throw new Error('Unknown vault');
    await switchVault(path, newWindow ? undefined : s.window);
  },
  'vaults.pick': (s, newWindow) => pickAndOpenVault(newWindow ? undefined : s.window),
  'vaults.manage': () => openLauncher(),
  'frames.open': (s, folder, files, inject, network) =>
    frames.open({
      owner: s.window.webContents.id,
      folder: s.abs(String(folder)),
      files: new Set((Array.isArray(files) ? files : []).map((f) => s.abs(String(f)))),
      inject: String(inject ?? ''),
      network: network === true,
    }),
  'frames.close': (s, token) => frames.close(String(token), s.window.webContents.id),
  'vaults.forget': async (_s, path) => {
    const config = await readConfig();
    const recent = (config.recent ?? []).filter((v) => v.path !== path);
    await writeConfig({ ...config, recent });
    buildMenu(recent.map((v) => v.path));
  },
  'net.fetchText': async (_s, url) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url))
      throw new Error('Only https URLs can be fetched');
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    if (text.length > 20_000_000) throw new Error('Response too large');
    return text;
  },
  'window.close': (s) => s.window.close(),
  'chatgpt.status': () => chatgpt().status(),
  'chatgpt.login': () => signInAware(() => chatgpt().login()),
  'chatgpt.logout': () => chatgpt().logout(),
  'chatgpt.models': () => signInAware(() => chatgpt().models()),
  'chatgpt.start': (s, id, body) => {
    if (typeof id !== 'number' || !body || typeof body !== 'object') throw new Error('Bad request');
    const key = `${s.window.webContents.id}:${id}`;
    const controller = new AbortController();
    chatgptStreams.set(key, controller);
    const send = (message: object) => {
      if (!s.window.isDestroyed()) s.window.webContents.send(IPC.chatgpt, { id, ...message });
    };
    // Runs on after this call returns; the renderer follows it through the events.
    void chatgpt()
      .responses(body, (event) => send({ event }), controller.signal)
      .then(
        () => send({ done: true }),
        (e: unknown) => {
          if (controller.signal.aborted) return;
          send({
            done: true,
            error: e instanceof Error ? e.message : String(e),
            needsSignIn: e instanceof ChatGptError && e.reauth,
          });
        },
      )
      .finally(() => chatgptStreams.delete(key));
  },
  'chatgpt.abort': (s, id) => {
    chatgptStreams.get(`${s.window.webContents.id}:${String(id)}`)?.abort();
  },
  'proc.spawn': (s, command, args, env) => s.processes.spawn(command, args, env),
  'proc.write': (s, id, data) => s.processes.write(id, data),
  'proc.closeStdin': (s, id) => s.processes.closeStdin(id),
  'proc.kill': (s, id) => s.processes.kill(id),
  'proc.which': (s, command) => s.processes.which(command),
};

ipcMain.handle(IPC.invoke, async (event, op: unknown, ...args: unknown[]) => {
  const handler = typeof op === 'string' ? handlers[op] : undefined;
  if (!handler) throw new Error(`Unknown operation ${String(op)}`);
  return handler(sessionFor(event), ...args);
});

async function openVault(root: string): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 360,
    title: basename(root),
    backgroundColor: '#1c1a18',
    titleBarStyle: OS === 'macos' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const session = new VaultSession(root, window);
  sessions.set(window.webContents.id, session);
  session.startWatching();

  // Links never navigate the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (e) => e.preventDefault());

  // Let the renderer flush pending saves before the window goes away.
  // The window is gone by the time `closed` fires: remember its id now.
  const contentsId = window.webContents.id;
  let closing = false;
  window.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    closing = true;
    const finish = () => {
      clearTimeout(timeout);
      ipcMain.off(IPC.closeReady, onReady);
      if (!window.isDestroyed()) window.destroy();
    };
    // Only this window's own renderer may release it (several vault windows can be open).
    const onReady = (event: Electron.IpcMainEvent) => {
      if (event.sender.id === contentsId) finish();
    };
    const timeout = setTimeout(finish, 2000);
    ipcMain.on(IPC.closeReady, onReady);
    window.webContents.send(IPC.beforeClose);
  });
  window.on('closed', () => {
    session.dispose();
    sessions.delete(contentsId);
    frames.closeAll(contentsId);
  });
  window.once('ready-to-show', () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadURL(`${APP_ORIGIN}/index.html`);

  await rememberVault(root);
}

async function pickAndOpenVault(replace?: BrowserWindow): Promise<boolean> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open a folder as vault',
    buttonLabel: 'Open vault',
    properties: ['openDirectory', 'createDirectory'],
  };
  const parent = BrowserWindow.getFocusedWindow();
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  const folder = result.filePaths[0];
  if (result.canceled || !folder) return false;
  await switchVault(folder, replace);
  return true;
}

// ---- Vault selector (the window shown when no vault is open) ------------------------------

let launcherWindow: BrowserWindow | null = null;

async function openLauncher(): Promise<void> {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 800,
    height: 560,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Pumice',
    backgroundColor: '#1c1a18',
    titleBarStyle: OS === 'macos' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  launcherWindow = window;
  window.setMenuBarVisibility(false);
  window.on('closed', () => {
    if (launcherWindow === window) launcherWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e) => e.preventDefault());
  window.once('ready-to-show', () => window.show());
  if (process.env.ELECTRON_RENDERER_URL)
    await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/launcher.html`);
  else await window.loadURL(`${APP_ORIGIN}/launcher.html`);
}

const closeLauncher = () => {
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.close();
};

async function launcherVaults() {
  const out = [];
  for (const v of (await readConfig()).recent ?? []) {
    const missing = !(await fs.stat(v.path).catch(() => null))?.isDirectory();
    out.push({ path: v.path, name: basename(v.path), missing });
  }
  return out;
}

const launcherHandlers: Record<string, (...args: unknown[]) => unknown> = {
  info: () => ({ version: app.getVersion(), defaultLocation: app.getPath('documents') }),
  list: () => launcherVaults(),
  open: async (path) => {
    const known = (await readConfig()).recent?.some((v) => v.path === path);
    if (typeof path !== 'string' || !known) throw new Error('Unknown vault');
    await switchVault(path);
    closeLauncher();
  },
  pick: async () => {
    if (await pickAndOpenVault()) closeLauncher();
  },
  chooseFolder: async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Where to create the vault',
      buttonLabel: 'Choose',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = launcherWindow
      ? await dialog.showOpenDialog(launcherWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  create: async (name, parent) => {
    if (typeof name !== 'string' || typeof parent !== 'string') throw new Error('Bad request');
    const clean = name.trim();
    if (!clean || /[\\/:*?"<>|]/.test(clean) || clean.startsWith('.'))
      throw new Error('That name can\u2019t be used for a folder.');
    if (!(await fs.stat(parent).catch(() => null))?.isDirectory())
      throw new Error('Choose a location for the vault.');
    const root = join(parent, clean);
    if (await fs.stat(root).catch(() => null))
      throw new Error(`\u201c${clean}\u201d already exists there. Open it as a folder instead.`);
    await fs.mkdir(root);
    await switchVault(root);
    closeLauncher();
  },
  forget: async (path) => {
    const config = await readConfig();
    const recent = (config.recent ?? []).filter((v) => v.path !== path);
    await writeConfig({ ...config, recent });
    buildMenu(recent.map((v) => v.path));
  },
  reveal: (path) => {
    if (typeof path === 'string') shell.showItemInFolder(path);
  },
};

ipcMain.handle(IPC.launcher, async (event, op: unknown, ...args: unknown[]) => {
  // Only the selector window may list, create and open vaults this way.
  if (!launcherWindow || event.sender.id !== launcherWindow.webContents.id)
    throw new Error('Not allowed');
  const handler = typeof op === 'string' ? launcherHandlers[op] : undefined;
  if (!handler) throw new Error(`Unknown operation ${String(op)}`);
  return handler(...args);
});

/** What a start (or a click on the Dock icon) shows: the last vault, else the selector. */
async function openLastVaultOrLauncher(): Promise<void> {
  const last = (await readConfig()).lastVault;
  if (last && (await fs.stat(last).catch(() => null))?.isDirectory()) await openVault(last);
  else await openLauncher();
}

function buildMenu(recent: string[] = []): void {
  const template: MenuItemConstructorOptions[] = [
    ...(OS === 'macos' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Manage Vaults…',
          click: () => void openLauncher(),
        },
        {
          label: 'Open Folder as Vault…',
          click: () => void pickAndOpenVault(),
        },
        {
          label: 'Open Recent Vault',
          enabled: recent.length > 0,
          submenu: recent.map((path) => ({
            label: `${basename(path)}  —  ${path}`,
            click: () =>
              void switchVault(path).catch((e: Error) =>
                dialog.showErrorBox('Could not open vault', e.message),
              ),
          })),
        },
        { type: 'separator' },
        OS === 'macos' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Checks for updates in packaged builds (electron-updater); downloads in the background. */
async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || process.env.PUMICE_NO_UPDATES) return;
  try {
    const { autoUpdater } = await import('electron-updater');
    if (process.env.PUMICE_UPDATE_URL)
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.PUMICE_UPDATE_URL });
    autoUpdater.autoInstallOnAppQuit = true;
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    console.warn('[pumice] update check failed', e);
  }
}

app.whenReady().then(async () => {
  serveRenderer();
  buildMenu(((await readConfig()).recent ?? []).map((v) => v.path));
  void checkForUpdates();
  // A vault path on the command line wins (handy for development: `pnpm dev -- /path/to/vault`).
  const fromArgs = process.argv.slice(1).find(
    (a) =>
      !a.startsWith('-') &&
      a !== '.' &&
      !a.endsWith('.js') &&
      // `electron <app folder>` passes the app itself first.
      resolve(a) !== app.getAppPath(),
  );
  const requested = fromArgs ? resolve(fromArgs) : process.env.PUMICE_VAULT;
  if (requested && (await fs.stat(requested).catch(() => null))?.isDirectory())
    await openVault(requested);
  else await openLastVaultOrLauncher();
});

app.on('window-all-closed', () => {
  if (OS !== 'macos') app.quit();
});

app.on('activate', () => {
  // macOS keeps the app running without windows: come back to the last vault.
  if (BrowserWindow.getAllWindows().length === 0) void openLastVaultOrLauncher();
});
