import type { FileStat, FsWatchEvent, KnownVault, PlatformOs } from '@pumice/platform';

/**
 * The API the preload script exposes as `window.pumiceHost`. Every call is validated in the
 * main process; paths are vault-relative and can't escape the vault root.
 */
export interface PumiceHost {
  info(): Promise<{ vaultName: string; vaultPath: string; os: PlatformOs; vaultId: string }>;
  fs: {
    list(): Promise<FileStat[]>;
    stat(path: string): Promise<FileStat | null>;
    readText(path: string): Promise<string>;
    readBinary(path: string): Promise<Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<FileStat>;
    rename(from: string, to: string): Promise<void>;
    remove(path: string, trash: boolean): Promise<void>;
    mkdir(path: string): Promise<void>;
  };
  storage: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  onWatch(listener: (events: FsWatchEvent[]) => void): () => void;
  /** Main asks the renderer to flush before the window closes; call `done` when finished. */
  onBeforeClose(listener: () => Promise<void>): () => void;
  openExternal(url: string): Promise<void>;
  revealInFileManager(path: string): Promise<void>;
  vaults: {
    list(): Promise<KnownVault[]>;
    /** Only vaults from `list()` can be opened this way. */
    open(path: string, newWindow: boolean): Promise<void>;
    /** Native folder dialog. */
    pick(newWindow: boolean): Promise<boolean>;
    forget(path: string): Promise<void>;
  };
  /** GET over https from the main process (the renderer's CSP blocks remote fetches). */
  fetchText(url: string): Promise<string>;
  /** Closes the window through the main process, so pending edits are flushed first. */
  closeWindow(): Promise<void>;
  proc: {
    /** Asks the user (native dialog) unless the command was allowed before; returns a process id. */
    spawn(command: string, args: string[], env?: Record<string, string>): Promise<number>;
    write(id: number, data: Uint8Array): Promise<void>;
    closeStdin(id: number): Promise<void>;
    kill(id: number): Promise<void>;
    which(command: string): Promise<string | null>;
    onEvent(listener: (event: ProcEvent) => void): () => void;
  };
}

export type ProcEvent =
  | { id: number; kind: 'stdout'; data: Uint8Array }
  | { id: number; kind: 'stderr'; data: string }
  | { id: number; kind: 'exit'; code: number | null };

/** IPC channel names shared by main and preload. */
export const IPC = {
  invoke: 'pumice:invoke',
  watch: 'pumice:watch',
  beforeClose: 'pumice:before-close',
  closeReady: 'pumice:close-ready',
  proc: 'pumice:proc',
} as const;
