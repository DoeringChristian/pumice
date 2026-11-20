/**
 * Platform abstraction: everything the app needs from the host OS.
 * Each shell (Electron, Capacitor, in-memory) provides one implementation.
 * Paths are vault-relative, '/'-separated, without a leading slash ('' is the vault root).
 */

export type VaultPath = string;

export interface FileStat {
  path: VaultPath;
  kind: 'file' | 'folder';
  size: number;
  /** Modification time in ms since epoch. */
  mtime: number;
}

export interface PlatformFs {
  /** Recursive listing of the whole vault (files and folders), excluding the vault root itself. */
  list(): Promise<FileStat[]>;
  stat(path: VaultPath): Promise<FileStat | null>;
  readText(path: VaultPath): Promise<string>;
  readBinary(path: VaultPath): Promise<Uint8Array>;
  /** Atomic write (temp file + rename). Creates parent folders. Returns the new stat. */
  write(path: VaultPath, data: string | Uint8Array): Promise<FileStat>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  remove(path: VaultPath, opts?: { trash?: boolean }): Promise<void>;
  mkdir(path: VaultPath): Promise<void>;
}

export interface FsWatchEvent {
  type: 'create' | 'modify' | 'delete';
  path: VaultPath;
}

export interface PlatformWatcher {
  /** Subscribes to external changes. Returns an unsubscribe function. */
  watch(listener: (events: FsWatchEvent[]) => void): () => void;
}

/** Per-device key/value storage outside the vault (caches, CRDT state, device settings). */
export interface AppStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Lifecycle {
  onPause(listener: () => void): () => void;
  onResume(listener: () => void): () => void;
}

export interface Shell {
  openExternal(url: string): Promise<void>;
  revealInFileManager?(path: VaultPath): Promise<void>;
}

export type PlatformKind = 'desktop' | 'mobile' | 'web';
export type PlatformOs = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown';

export interface Net {
  /** GETs a text resource over https. */
  fetchText(url: string): Promise<string>;
}

/** A child process (an agent CLI) started in the vault folder. */
export interface ChildProcessHandle {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  /** Diagnostic output, decoded. */
  onStderr(listener: (text: string) => void): () => void;
  /** Resolves with the exit code (null when killed by a signal). */
  readonly exited: Promise<number | null>;
  kill(): void;
}

/**
 * Starting local programs (desktop only). The shell confirms each new command with the user in a
 * native dialog before it first runs; processes run with the vault folder as working directory.
 */
export interface ProcessHost {
  spawn(
    command: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ): Promise<ChildProcessHandle>;
  /** Absolute path of an executable on the user's PATH, or null. */
  which(command: string): Promise<string | null>;
}

/**
 * "Sign in with ChatGPT": the user's ChatGPT plan pays for the built-in assistant. The shell
 * holds the tokens and makes the requests (OpenAI requires both to stay out of the page).
 */
export interface ChatGptHost {
  status(): Promise<{ signedIn: boolean; email: string | null; planUsage: boolean }>;
  /** Opens OpenAI's consent page in the browser; poll `status()` for the result. */
  login(): Promise<void>;
  logout(): Promise<void>;
  models(): Promise<Array<{ id: string; name: string }>>;
  /**
   * One streamed Responses API request; `onEvent` gets each server-sent event. A failed request
   * arrives as `{ type: 'http_error', status, body }`. Rejects with `needsSignIn` set on the
   * error when the user has to sign in (again).
   */
  responses(
    body: Record<string, unknown>,
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** A vault the app knows about (opened before, or living in app storage on mobile). */
export interface KnownVault {
  /** Opaque handle for `open`/`forget` (a folder path on desktop). */
  id: string;
  name: string;
  /** Where it is, for display (folder path). */
  location?: string;
  current: boolean;
  /** Last opened, ms since epoch. */
  lastOpened?: number;
}

/** Choosing and switching vaults; absent where there is only one (web demo). */
export interface VaultSwitcher {
  list(): Promise<KnownVault[]>;
  /** Switches to a known vault. Desktop: `newWindow` keeps the current one open. */
  open(id: string, opts?: { newWindow?: boolean }): Promise<void>;
  /** Lets the user choose a folder to open as a vault. Resolves false when cancelled. */
  pick(opts?: { newWindow?: boolean }): Promise<boolean>;
  /** Creates an empty vault in the app's own storage and opens it (mobile). */
  create?(name: string): Promise<void>;
  /** Removes a vault from the list. Its files are not touched. */
  forget(id: string): Promise<void>;
  /** Opens the shell's own vault manager, if it has one (desktop). */
  manage?(): Promise<void>;
}

export interface Platform {
  readonly kind: PlatformKind;
  readonly os: PlatformOs;
  /** Display name of the open vault (usually its folder name). */
  readonly vaultName: string;
  /** Absolute path of the vault folder where the vault is a real folder (desktop). */
  readonly vaultRoot?: string;
  readonly fs: PlatformFs;
  /** Absent on platforms without file watching (mobile); those rescan on resume. */
  readonly watcher?: PlatformWatcher;
  readonly storage: AppStorage;
  readonly lifecycle: Lifecycle;
  readonly shell: Shell;
  /** Network access for the app shell (plugin installs); absent where `fetch` is enough. */
  readonly net?: Net;
  readonly vaults?: VaultSwitcher;
  /** Absent where the shell can't keep tokens out of the page (web, mobile for now). */
  readonly chatgpt?: ChatGptHost;
  /** Absent where programs can't be started (web, mobile). */
  readonly process?: ProcessHost;
}

export function normalizePath(path: string): VaultPath {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export function dirname(path: VaultPath): VaultPath {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path: VaultPath): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function joinPath(...parts: string[]): VaultPath {
  return normalizePath(parts.filter(Boolean).join('/'));
}
