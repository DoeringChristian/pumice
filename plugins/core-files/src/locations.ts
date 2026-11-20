import {
  dirname,
  joinPath,
  normalizePath,
  type FileLocationsApi,
  type FolderRule,
  type VaultApi,
  type VaultPath,
} from '@pumice/api';

export const DEFAULT_RULE: FolderRule = { mode: 'root', folder: '' };

/** Obsidian's `attachmentFolderPath`: "/" = root, "./" = same folder, "./x" = subfolder, "x" = folder. */
export function ruleFromObsidian(value: unknown): FolderRule | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '' || v === '/') return { mode: 'root', folder: '' };
  if (v === './' || v === '.') return { mode: 'same', folder: '' };
  if (v.startsWith('./')) return { mode: 'subfolder', folder: normalizePath(v.slice(2)) };
  return { mode: 'folder', folder: normalizePath(v) };
}

export function folderFor(rule: FolderRule, source: VaultPath | undefined): VaultPath {
  const here = source ? dirname(source) : '';
  switch (rule.mode) {
    case 'folder':
      return normalizePath(rule.folder);
    case 'same':
      return here;
    case 'subfolder':
      return rule.folder.trim() ? joinPath(here, normalizePath(rule.folder)) : here;
    default:
      return '';
  }
}

export class FileLocationsImpl implements FileLocationsApi {
  constructor(
    private readonly vault: VaultApi,
    private readonly rules: { attachments(): FolderRule; drawings(): FolderRule },
  ) {}

  attachmentFolder(source?: VaultPath): VaultPath {
    return folderFor(this.rules.attachments(), source);
  }

  drawingFolder(source?: VaultPath): VaultPath {
    return folderFor(this.rules.drawings(), source);
  }

  attachmentPath(source: VaultPath | undefined, name: string, extension: string): VaultPath {
    return this.vault.availablePath(this.attachmentFolder(source), name, extension);
  }

  drawingPath(source: VaultPath | undefined, name: string): VaultPath {
    return this.vault.availablePath(this.drawingFolder(source), name, 'excalidraw.md');
  }
}

/** A file name that works on every platform, without its extension. */
export function splitFileName(name: string): { base: string; extension: string } {
  const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim() || 'file';
  const dot = clean.lastIndexOf('.');
  if (dot <= 0) return { base: clean, extension: '' };
  return { base: clean.slice(0, dot), extension: clean.slice(dot + 1).toLowerCase() };
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

/** Name for a pasted file: its own name, or "pasted-image-20261120143000" for clipboard images. */
export function attachmentName(file: { name: string; type: string }, now = new Date()) {
  const fromMime = MIME_EXT[file.type];
  // Clipboard images arrive as "image.png".
  const generic = !file.name || /^image\.[a-z]+$/i.test(file.name);
  if (generic) {
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return { base: `pasted-image-${stamp}`, extension: fromMime ?? 'png' };
  }
  const { base, extension } = splitFileName(file.name);
  return { base, extension: extension || fromMime || 'bin' };
}
