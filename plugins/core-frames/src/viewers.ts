import type { VaultPath } from '@pumice/api';

/**
 * A frame can offer itself as a viewer for whole files: a `frame.json` beside its `index.html`
 * names the file types it opens. Such a file then opens in a tab through the frame, which gets
 * it as one of its settings.
 */
export interface FrameViewer {
  /** The frame's HTML file. */
  entry: VaultPath;
  /** What the user sees when choosing a viewer. */
  name: string;
  /** File endings without the dot, lowercase. */
  extensions: string[];
  /** The setting the opened file is passed as. */
  setting: string;
  /** The setting takes a list of files (to compare them, say), also when there is one. */
  multiple: boolean;
  /** The frame's other settings, as its manifest describes them (offered while writing a block). */
  settings: Record<string, SettingDoc>;
}

/** What a frame says about one of its settings. */
export interface SettingDoc {
  description?: string;
  /** The values it can take, if they are few. */
  values?: string[];
  default?: string;
  /** `file`: the value is a file of the vault. */
  type?: string;
}

function settingDocs(value: unknown): Record<string, SettingDoc> {
  const docs: Record<string, SettingDoc> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return docs;
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[\w-]+$/.test(key)) continue;
    if (typeof raw === 'string') docs[key] = { description: raw };
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      docs[key] = {
        ...(typeof r.description === 'string' ? { description: r.description } : {}),
        ...(Array.isArray(r.values) ? { values: r.values.map(String) } : {}),
        ...(r.default !== undefined ? { default: String(r.default) } : {}),
        ...(typeof r.type === 'string' ? { type: r.type } : {}),
      };
    }
  }
  return docs;
}

/** Reads a frame's manifest; undefined when it does not offer to open any file type. */
export function parseFrameManifest(text: string, manifestPath: VaultPath): FrameViewer | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const m = data as Record<string, unknown>;
  const opens = (m.opens && typeof m.opens === 'object' ? m.opens : m) as Record<string, unknown>;
  const extensions = (Array.isArray(opens.extensions) ? opens.extensions : [])
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim().replace(/^\./, '').toLowerCase())
    .filter((e) => /^[a-z0-9][a-z0-9.+-]*$/.test(e));
  if (!extensions.length) return undefined;
  const dir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
  const folderName = dir.slice(dir.lastIndexOf('/') + 1);
  // `file`, `caption`, `width` and `height` are the block's own keys.
  const named = typeof opens.setting === 'string' ? opens.setting.trim() : '';
  const setting = named && !['file', 'caption', 'width', 'height'].includes(named) ? named : 'data';
  return {
    entry: `${dir}/${typeof m.entry === 'string' && /\.html?$/i.test(m.entry) ? m.entry : 'index.html'}`,
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : folderName,
    extensions: [...new Set(extensions)],
    setting,
    multiple: opens.multiple === true,
    settings: settingDocs(m.settings),
  };
}

/** Whether a path is a frame's manifest inside the frames folder (`<folder>/<name>/frame.json`). */
export function isFrameManifest(path: VaultPath, framesFolder: string): boolean {
  const prefix = framesFolder ? `${framesFolder}/` : '';
  if (!path.startsWith(prefix) || !path.endsWith('/frame.json')) return false;
  return path.slice(prefix.length).split('/').length === 2;
}

/** The block that shows files through a frame, as it is written into a note. */
export function frameBlock(viewer: FrameViewer, files: VaultPath[]): string {
  const lines = ['```frame', `file: [[${viewer.entry}]]`];
  if (viewer.multiple) {
    lines.push(`${viewer.setting}:`, ...files.map((f) => `  - [[${f}]]`));
    if (!files.length) lines[lines.length - 1] = `${viewer.setting}: []`;
  } else if (files[0]) lines.push(`${viewer.setting}: [[${files[0]}]]`);
  lines.push('```');
  return lines.join('\n');
}

/** Whether a frame offers to show this file. */
export function opens(viewer: FrameViewer, path: VaultPath): boolean {
  const name = path.toLowerCase();
  return viewer.extensions.some((ext) => name.endsWith(`.${ext}`));
}

/**
 * The frame a dropped path stands for: its `index.html`, its `frame.json`, or its folder.
 */
export function viewerAt(viewers: FrameViewer[], path: VaultPath): FrameViewer | undefined {
  return viewers.find((v) => {
    const dir = v.entry.slice(0, v.entry.lastIndexOf('/'));
    return path === v.entry || path === dir || path === `${dir}/frame.json`;
  });
}
