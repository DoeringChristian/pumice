import {
  dirname,
  type DisposableLike,
  type MetadataIndexApi,
  type FrameHost,
  type VaultApi,
  type VaultPath,
} from '@pumice/api';
import { h } from '@pumice/ui';
import { FRAME_KIT, HOST_KEY, SERIES, THEME_VARS, withKit, type FrameTheme } from './kit';
import { entryCandidates, mapLinks, type FrameSpec } from './spec';

export interface FrameDeps {
  vault: VaultApi;
  index: MetadataIndexApi;
  frames: FrameHost | undefined;
  /** Folder that holds the vault's frames. */
  folder(): string;
  /** Whether frames may reach the network. */
  network(): boolean;
}

const MIME: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};
const mime = (path: string) =>
  MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

function dataUrl(bytes: Uint8Array, type: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

/** The app's current theme, as frames get it. */
export function currentTheme(): FrameTheme {
  const style = getComputedStyle(document.documentElement);
  const dark = style.colorScheme.trim().startsWith('dark');
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  (dark ? SERIES.dark : SERIES.light).forEach((c, i) => (vars[`--series-${i + 1}`] = c));
  return { dark, vars };
}

// One watcher tells every open frame when the app switches between light and dark.
const openFrames = new Set<HTMLIFrameElement>();
let watching = false;
function watchTheme(): void {
  if (watching) return;
  watching = true;
  let last = JSON.stringify(currentTheme());
  const check = () => {
    const theme = currentTheme();
    const now = JSON.stringify(theme);
    if (now === last) return;
    last = now;
    for (const frame of openFrames)
      frame.contentWindow?.postMessage({ type: 'pumice-theme', theme }, '*');
  };
  new MutationObserver(check).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style', 'class'],
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', check);
}

/** The HTML file a block names: a link, a path, or the name of a frame in the frames folder. */
export function resolveEntry(file: string, sourcePath: VaultPath, deps: FrameDeps): VaultPath {
  const linked = deps.index.resolve(file, sourcePath)?.file.path;
  if (linked && /\.html?$/i.test(linked)) return linked;
  for (const candidate of entryCandidates(file, deps.folder())) {
    if (deps.vault.get(candidate)?.kind === 'file') return candidate;
  }
  throw new Error(`There is no HTML file "${file}" in this vault.`);
}

/**
 * Where the frame's page and its data come from. With a host (desktop) the files are served
 * under an address of their own, so the page loads what is beside it by relative path. Without
 * one (web, mobile) the page is put together here: the scripts, styles and images it refers to
 * are placed inside it, and data files are handed over whole.
 */
async function openSource(entry: VaultPath, files: VaultPath[], deps: FrameDeps) {
  if (deps.frames) {
    const access = await deps.frames.open({
      folder: dirname(entry),
      files,
      inject: FRAME_KIT,
      network: deps.network(),
    });
    return {
      page: async () => access.url(entry),
      file: async (path: VaultPath) => access.url(path),
      dispose: () => access.dispose(),
    };
  }
  const urls: string[] = [];
  const base = dirname(entry);
  const inline = async (ref: string): Promise<string | undefined> => {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref)) return undefined;
    const parts: string[] = base ? base.split('/') : [];
    for (const part of ref.split(/[?#]/)[0]!.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(decodeURIComponent(part));
    }
    const path = parts.join('/');
    if (deps.vault.get(path)?.kind !== 'file') return undefined;
    return dataUrl(await deps.vault.readBinary(path), mime(path));
  };
  return {
    page: async () => {
      let html = await deps.vault.read(entry);
      const refs = [
        ...html.matchAll(
          /<(?:script|img|video|audio|source|link)\b[^>]*?\s(?:src|href)=(["'])(.*?)\1/gi,
        ),
      ];
      for (const ref of refs) {
        const url = await inline(ref[2]!);
        if (url) html = html.replace(ref[0], ref[0].replace(ref[2]!, url));
      }
      const url = URL.createObjectURL(new Blob([withKit(html)], { type: 'text/html' }));
      urls.push(url);
      return url;
    },
    file: async (path: VaultPath) => dataUrl(await deps.vault.readBinary(path), mime(path)),
    dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  };
}

export interface MountOptions {
  spec: FrameSpec;
  /** Note the frame is shown in (links resolve relative to it). */
  sourcePath: VaultPath;
  /** Fill the container instead of taking the content's height (a frame opened in a tab). */
  fill?: boolean;
  register(disposable: DisposableLike): void;
}

/** Shows a frame in `container`. Reloads when its files or data change on disk. */
export async function mountFrame(
  container: HTMLElement,
  options: MountOptions,
  deps: FrameDeps,
): Promise<void> {
  const { spec, sourcePath } = options;
  const figure = h('figure', { class: 'pm-frame' });
  figure.classList.toggle('is-fill', !!options.fill);
  container.replaceChildren(figure);
  let disposed = false;
  let source: Awaited<ReturnType<typeof openSource>> | undefined;
  let frame: HTMLIFrameElement | undefined;
  let watched = new Set<VaultPath>();
  let folder = '';
  let generation = 0;

  const fail = (e: unknown) => {
    figure.replaceChildren(
      h('div', { class: 'pm-frame-error' }, e instanceof Error ? e.message : String(e)),
    );
    figure.dispatchEvent(new CustomEvent('pumice-resize', { bubbles: true }));
  };

  const load = async () => {
    const gen = ++generation;
    source?.dispose();
    source = undefined;
    const entry = resolveEntry(spec.file, sourcePath, deps);
    folder = dirname(entry);
    // Links in the settings: the files become addresses the frame can load.
    const files = new Set<VaultPath>();
    const targets = new Map<string, VaultPath>();
    await mapLinks(spec.settings, async (target, raw) => {
      const path =
        deps.index.resolve(target, sourcePath)?.file.path ??
        (deps.vault.get(target)?.kind === 'file' ? target : undefined);
      if (!path) throw new Error(`This frame links to ${raw}, which is not in the vault.`);
      files.add(path);
      targets.set(raw, path);
      return raw;
    });
    watched = files;
    const opened = await openSource(entry, [...files], deps);
    if (disposed || gen !== generation) return opened.dispose();
    source = opened;
    const settings = (await mapLinks(spec.settings, async (_target, raw) =>
      opened.file(targets.get(raw)!),
    )) as Record<string, unknown>;
    const page = await opened.page();
    if (disposed || gen !== generation) return;

    const next = h('iframe', {
      class: 'pm-frame-view',
      // Scripts, but an origin of its own: no access to the app or the vault.
      sandbox: 'allow-scripts allow-pointer-lock',
      allow: 'fullscreen',
      title: spec.caption ?? entry,
    });
    if (spec.height) next.style.height = `${spec.height}px`;
    else if (!options.fill && frame) next.style.height = frame.style.height;
    next.src = `${page}#${encodeURIComponent(JSON.stringify({ ...settings, [HOST_KEY]: currentTheme() }))}`;
    if (frame) openFrames.delete(frame);
    frame = next;
    openFrames.add(next);
    watchTheme();
    figure.replaceChildren(
      next,
      ...(spec.caption ? [h('figcaption', { class: 'pm-frame-caption' }, spec.caption)] : []),
    );
    figure.dispatchEvent(new CustomEvent('pumice-resize', { bubbles: true }));
  };

  // The page reports the height of its content.
  const onMessage = (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type !== 'pumice-frame-size' && type !== 'cairn-html-size') return;
    if (spec.height || options.fill) return;
    const height = Number((event.data as { height?: unknown }).height);
    if (!Number.isFinite(height)) return;
    const px = `${Math.max(40, Math.min(4000, Math.ceil(height)))}px`;
    if (frame.style.height === px) return;
    frame.style.height = px;
    figure.dispatchEvent(new CustomEvent('pumice-resize', { bubbles: true }));
  };
  window.addEventListener('message', onMessage);

  // An agent (or the user) changed the frame or its data: show the new state.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sub = deps.vault.onDidChange((changes) => {
    const touched = changes.some((c) => {
      const path = c.type === 'delete' ? c.path : c.entry.path;
      return watched.has(path) || (folder ? path.startsWith(`${folder}/`) : !path.includes('/'));
    });
    if (!touched) return;
    clearTimeout(timer);
    timer = setTimeout(() => void load().catch(fail), 400);
  });

  options.register(() => {
    disposed = true;
    clearTimeout(timer);
    sub.dispose();
    window.removeEventListener('message', onMessage);
    if (frame) openFrames.delete(frame);
    source?.dispose();
  });

  await load().catch(fail);
}
