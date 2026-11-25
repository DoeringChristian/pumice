import type { VaultPath } from '@pumice/platform';
import type { Event } from '../lifecycle';
import { defineService } from '../service';

export interface VaultFile {
  kind: 'file';
  path: VaultPath;
  /** File name including extension. */
  name: string;
  /** File name without its (last) extension. */
  basename: string;
  /** Last extension without the dot, lowercased; '' if none. */
  extension: string;
  size: number;
  mtime: number;
}

export interface VaultFolder {
  kind: 'folder';
  path: VaultPath;
  name: string;
}

export type VaultEntry = VaultFile | VaultFolder;

export type VaultChange =
  | { type: 'create'; entry: VaultEntry; external: boolean }
  | { type: 'modify'; entry: VaultFile; external: boolean }
  | { type: 'delete'; path: VaultPath; kind: VaultEntry['kind']; external: boolean }
  | { type: 'rename'; oldPath: VaultPath; entry: VaultEntry; external: boolean };

export interface VaultApi {
  readonly name: string;
  /** Root folder path ('') and all entries, excluding the `.pumice` config folder. */
  get(path: VaultPath): VaultEntry | undefined;
  files(): VaultFile[];
  folders(): VaultFolder[];
  /** Direct children of a folder, folders first, then by name. */
  children(folder: VaultPath): VaultEntry[];

  read(path: VaultPath): Promise<string>;
  readBinary(path: VaultPath): Promise<Uint8Array>;
  /** Part of a file (shorter at its end); undefined where only whole files can be read. */
  readRange(path: VaultPath, offset: number, length: number): Promise<Uint8Array | undefined>;
  /** Creates a new file; fails if it exists. */
  create(path: VaultPath, content: string | Uint8Array): Promise<VaultFile>;
  /** Overwrites a file (creates it if missing). Open documents merge the change. */
  write(path: VaultPath, content: string | Uint8Array): Promise<VaultFile>;
  createFolder(path: VaultPath): Promise<VaultFolder>;
  rename(from: VaultPath, to: VaultPath): Promise<VaultEntry>;
  delete(path: VaultPath): Promise<void>;
  /** First free path `folder/basename.ext`, `folder/basename 1.ext`, ... */
  availablePath(folder: VaultPath, basename: string, extension: string): VaultPath;

  /** Re-reads the file tree and reports external changes (mobile resume, manual refresh). */
  rescan(): Promise<void>;
  readonly onDidChange: Event<VaultChange[]>;
}

export const Vault = defineService<VaultApi>('core.vault');
