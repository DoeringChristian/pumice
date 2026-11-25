import type { VaultPath } from '@pumice/platform';
import { defineService } from '../service';

/**
 * Where new files go:
 * - `root`: the vault's top folder
 * - `folder`: the folder named in `folder` (a vault path)
 * - `same`: the folder of the note they are added from
 * - `subfolder`: a folder named `folder` next to that note
 */
export interface FolderRule {
  mode: 'root' | 'folder' | 'same' | 'subfolder';
  folder: string;
}

/** Default folders for files the app creates (settings: Files). Provided by `core.files`. */
export interface FileLocationsApi {
  /** Folder for media added to `source` (pasted or dropped images, files, …). */
  attachmentFolder(source?: VaultPath): VaultPath;
  /** Folder for new drawings created from `source`. */
  drawingFolder(source?: VaultPath): VaultPath;
  /** A free path `folder/name.ext` in the attachment folder. */
  attachmentPath(source: VaultPath | undefined, name: string, extension: string): VaultPath;
  /** A free path for a new drawing (`name.excalidraw`). */
  drawingPath(source: VaultPath | undefined, name: string): VaultPath;
}

export const FileLocations = defineService<FileLocationsApi>('core.files');
