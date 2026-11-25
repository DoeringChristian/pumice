import {
  embedSizeCss,
  dirname,
  type DisposableLike,
  type MetadataIndexApi,
  type FrameHost,
  type VaultApi,
  type VaultPath,
} from '@pumice/api';
import { h } from '@pumice/ui';
import { FRAME_KIT, HOST_KEY, SERIES, THEME_VARS, withKit, type FrameTheme } from './kit';
import { RESERVED, entryCandidates, hasRef, mapRefs, type FrameSpec } from './spec';
import { opens, type FrameViewer } from './viewers';

export interface FrameDeps {
  vault: VaultApi;
  index: MetadataIndexApi;
  frames: FrameHost | undefined;
  /** Folder that holds the vault's frames. */
  folder(): string;
  /** Whether frames may reach the network. */
  network(): boolean;
  /** What the frame with this HTML file says it shows (its `frame.json`), if anything. */
  viewerFor(entry: VaultPath): FrameViewer | undefined;
  notify(message: string): void;
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
async function openSource(entry: VaultPath, files: VaultPath[], remote: string[], deps: FrameDeps) {
  if (deps.frames) {
    const access = await deps.frames.open({
      folder: dirname(entry),
      files,
      inject: FRAME_KIT,
      network: deps.network(),
      remote,
    });
    return {
      page: async () => access.url(entry),
      file: async (path: VaultPath) => access.url(path),
      remote: (url: string) => access.remoteUrl(url),
      extend: (more: VaultPath[], moreRemote: string[]) => access.extend(more, moreRemote),
      dispose: () => access.dispose(),
    };
  }
  return inlineSource(entry, deps);
}

/** The frame's page put together here, with what it refers to inside it (no host needed). */
function inlineSource(entry: VaultPath, deps: FrameDeps) {
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
  const html = async () => {
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
    return html;
  };
  return {
    html,
    page: async () => {
      const url = URL.createObjectURL(new Blob([withKit(await html())], { type: 'text/html' }));
      urls.push(url);
      return url;
    },
    file: async (path: VaultPath) => dataUrl(await deps.vault.readBinary(path), mime(path)),
    // No server of its own here: the page loads the address itself.
    remote: (url: string) => url,
    extend: async () => undefined,
    dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  };
}

export interface MountOptions {
  spec: FrameSpec;
  /** Note the frame is shown in (links resolve relative to it). */
  sourcePath: VaultPath;
  /** Fill the container instead of taking the content's height (a frame opened in a tab). */
  fill?: boolean;
  /**
   * Writes changed settings to where the frame is declared (its block in the note). Resolves
   * to false when that is not possible; the change then lasts as long as the frame is shown.
   */
  persist?(settings: Record<string, unknown>): Promise<boolean> | boolean;
  register(disposable: DisposableLike): void;
}

/** A frame that is being shown. */
export interface MountedFrame {
  /**
   * Takes over a changed declaration without starting over where possible. False when the
   * frame cannot become that (another HTML file): show it anew.
   */
  setSpec(spec: FrameSpec): boolean;
}

/** Frames that are shown, by their element: how each is written out for an export. */
const exporters = new WeakMap<HTMLElement, (light: boolean) => Promise<string>>();

/** See `FramesApi.exportHtml`. */
export async function exportFrameHtml(
  figure: HTMLElement,
  light: boolean,
): Promise<string | undefined> {
  return exporters.get(figure)?.(light);
}

/** What the file list puts on a drag: the vault path. */
const VAULT_DRAG = 'application/x-pumice-path';

// A frame's page would swallow a file dragged over it: while a file from the list is being
// dragged, frames let the pointer through to the app.
let dragWatch = false;
function watchDrags(): void {
  if (dragWatch) return;
  dragWatch = true;
  const on = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes(VAULT_DRAG))
      document.documentElement.classList.add('pm-dragging-file');
  };
  const off = () => document.documentElement.classList.remove('pm-dragging-file');
  // After the file list has said what is dragged (hence not in the capture phase), so that
  // frames step aside before the pointer reaches one.
  window.addEventListener('dragstart', on);
  window.addEventListener('dragenter', on, true);
  window.addEventListener('dragover', on, true);
  window.addEventListener('dragend', off, true);
  window.addEventListener('drop', off, true);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Shows a frame in `container`. Reloads when its files or data change on disk. */
export async function mountFrame(
  container: HTMLElement,
  options: MountOptions,
  deps: FrameDeps,
): Promise<MountedFrame> {
  const { sourcePath } = options;
  let spec = options.spec;
  const figure = h('figure', { class: 'pm-frame' });
  figure.classList.toggle('is-fill', !!options.fill);
  /** A frame block has its width itself; an embed, or a tab, is a box that has one. */
  const setWidth = (width: number | undefined) => {
    if (options.fill || container.classList.contains('pm-embed')) return;
    const css = embedSizeCss(width ? { w: { value: width, unit: '' } } : {}).width;
    figure.style.width = css ?? '';
    figure.style.maxWidth = css ? '100%' : '';
  };
  setWidth(spec.width);
  container.replaceChildren(figure);
  let disposed = false;
  exporters.set(figure, async (light) => {
    const entry = resolveEntry(spec.file, sourcePath, deps);
    const inline = inlineSource(entry, deps);
    const { targets } = await refsOf(spec.settings);
    // The data as addresses that hold it (a page opened from a file cannot load files).
    const settings = (await mapRefs(spec.settings, async (ref) =>
      ref.kind === 'web' ? ref.target : await inline.file(targets.get(ref.raw)!),
    )) as Record<string, unknown>;
    const theme: FrameTheme = light
      ? {
          dark: false,
          vars: Object.fromEntries(SERIES.light.map((c, i) => [`--series-${i + 1}`, c])),
        }
      : currentTheme();
    const given = JSON.stringify({ ...settings, [HOST_KEY]: theme }).replace(/</g, '\\u003c');
    return withKit(
      await inline.html(),
      `<script>window.__pumiceSettings=${given}</script>${FRAME_KIT}`,
    );
  });
  let source: Awaited<ReturnType<typeof openSource>> | undefined;
  let frame: HTMLIFrameElement | undefined;
  let watched = new Set<VaultPath>();
  let folder = '';
  let entryPath: VaultPath | undefined;
  let generation = 0;
  /** Addresses the page was given, back to how the note writes them. */
  let written = new Map<string, string>();
  /** Settings the page itself asked for: it shows them already, no need to start it over. */
  let shown: Record<string, unknown> | undefined;
  /** The page said it follows changed settings itself. */
  let live = false;

  const fail = (e: unknown) => {
    figure.replaceChildren(
      h('div', { class: 'pm-frame-error' }, e instanceof Error ? e.message : String(e)),
    );
    figure.dispatchEvent(new CustomEvent('pumice-resize', { bubbles: true }));
  };

  /** The files and web resources the settings refer to. */
  const refsOf = async (settings: Record<string, unknown>) => {
    const files = new Set<VaultPath>();
    const remote = new Set<string>();
    const targets = new Map<string, VaultPath>();
    await mapRefs(settings, async (ref) => {
      if (ref.kind === 'web') {
        remote.add(ref.target);
        return ref.raw;
      }
      const path =
        deps.index.resolve(ref.target, sourcePath)?.file.path ??
        (deps.vault.get(ref.target)?.kind === 'file' ? ref.target : undefined);
      if (!path) throw new Error(`This frame links to ${ref.raw}, which is not in the vault.`);
      files.add(path);
      targets.set(ref.raw, path);
      return ref.raw;
    });
    return { files, remote, targets };
  };
  /** The settings as the page gets them: every reference an address it can load. */
  const addressed = async (
    from: NonNullable<typeof source>,
    settings: Record<string, unknown>,
    targets: Map<string, VaultPath>,
  ) => {
    const addresses = new Map<string, string>();
    const resolved = (await mapRefs(settings, async (ref) => {
      const address =
        ref.kind === 'web' ? from.remote(ref.target) : await from.file(targets.get(ref.raw)!);
      addresses.set(address, ref.raw);
      return address;
    })) as Record<string, unknown>;
    return { settings: resolved, addresses };
  };

  /**
   * Shows changed settings: a page that follows its settings (`pumice.onSettings`) gets them
   * handed over and keeps running; any other page is loaded anew.
   */
  const show = async () => {
    if (!live || !frame || !source) return load();
    const gen = generation;
    const { files, remote, targets } = await refsOf(spec.settings);
    await source.extend([...files], [...remote]);
    const { settings, addresses } = await addressed(source, spec.settings, targets);
    if (disposed || gen !== generation || !frame) return;
    watched = files;
    for (const [address, raw] of addresses) written.set(address, raw);
    frame.contentWindow?.postMessage({ type: 'pumice-settings', settings }, '*');
  };

  const load = async () => {
    const gen = ++generation;
    source?.dispose();
    source = undefined;
    const entry = resolveEntry(spec.file, sourcePath, deps);
    entryPath = entry;
    folder = dirname(entry);
    const { files, remote, targets } = await refsOf(spec.settings);
    watched = files;
    const opened = await openSource(entry, [...files], [...remote], deps);
    if (disposed || gen !== generation) return opened.dispose();
    source = opened;
    const { settings, addresses } = await addressed(opened, spec.settings, targets);
    const page = await opened.page();
    if (disposed || gen !== generation) return;
    written = addresses;
    live = false;

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

  /**
   * New settings for the frame: written to the note if possible. `fromPage`: the page asked
   * for them itself and shows them already.
   */
  const apply = async (settings: Record<string, unknown>, fromPage: boolean) => {
    if (same(settings, spec.settings)) return;
    if (fromPage) shown = settings;
    const persisted = !!options.persist && (await options.persist(settings));
    // Written to the note: the changed block comes back through `setSpec`.
    if (persisted || disposed) return;
    spec = { ...spec, settings };
    shown = undefined;
    if (!fromPage) await show().catch(fail);
  };

  const onMessage = (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown; height?: unknown; settings?: unknown } | null;
    if (data?.type === 'pumice-frame-live') {
      live = true;
      return;
    }
    // The page changes its own settings (`pumice.update`): they are kept in the note.
    if (data?.type === 'pumice-frame-update') {
      const patch = data.settings;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
      if (JSON.stringify(patch).length > 50_000) return;
      // A page gets files only from the note: it cannot name further ones itself.
      if (hasRef(patch)) {
        console.warn('[pumice] a frame asked for a file it was not given; ignored');
        return;
      }
      const back = (value: unknown): unknown =>
        typeof value === 'string'
          ? (written.get(value) ?? value)
          : Array.isArray(value)
            ? value.map(back)
            : value && typeof value === 'object'
              ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, back(v)]))
              : value;
      const next: Record<string, unknown> = { ...spec.settings };
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        if (RESERVED.includes(key) || key === HOST_KEY) continue;
        if (value === null || value === undefined) delete next[key];
        else next[key] = back(value);
      }
      void apply(next, true);
      return;
    }
    // The page reports the height of its content.
    if (data?.type !== 'pumice-frame-size' && data?.type !== 'cairn-html-size') return;
    if (spec.height || options.fill) return;
    // The user is dragging the frame to a size.
    if (figure.closest('.is-resizing')) return;
    const height = Number(data.height);
    if (!Number.isFinite(height)) return;
    const px = `${Math.max(40, Math.min(4000, Math.ceil(height)))}px`;
    if (frame.style.height === px) return;
    frame.style.height = px;
    figure.dispatchEvent(new CustomEvent('pumice-resize', { bubbles: true }));
  };
  window.addEventListener('message', onMessage);

  // A file dragged from the file list onto the frame is added to what it shows.
  watchDrags();
  const takes = (e: DragEvent) => !!e.dataTransfer?.types.includes(VAULT_DRAG);
  figure.addEventListener('dragover', (e) => {
    if (!takes(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = 'copy';
    figure.classList.add('is-drop');
  });
  figure.addEventListener('dragleave', () => figure.classList.remove('is-drop'));
  figure.addEventListener('drop', (e) => {
    if (!takes(e)) return;
    // The frame takes it: the note around it does not get a link as well.
    e.preventDefault();
    e.stopPropagation();
    figure.classList.remove('is-drop');
    const path = e.dataTransfer!.getData(VAULT_DRAG);
    const viewer = entryPath ? deps.viewerFor(entryPath) : undefined;
    if (!viewer) {
      deps.notify('This frame does not say which files it takes (it has no frame.json).');
      return;
    }
    if (deps.vault.get(path)?.kind !== 'file' || !opens(viewer, path)) {
      deps.notify(
        `${viewer.name} takes ${viewer.extensions.map((x) => `.${x}`).join(', ')} files.`,
      );
      return;
    }
    const ref = `[[${path}]]`;
    const current = spec.settings[viewer.setting];
    const list = current === undefined ? [] : Array.isArray(current) ? current : [current];
    // The same file may be added again: comparing something with itself is a valid start.
    void apply(
      { ...spec.settings, [viewer.setting]: viewer.multiple ? [...list, ref] : ref },
      false,
    );
  });

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

  return {
    setSpec(next) {
      if (disposed || next.file !== spec.file) return false;
      const before = spec;
      spec = next;
      setWidth(next.width);
      if (frame && next.height) frame.style.height = `${next.height}px`;
      const caption = figure.querySelector('.pm-frame-caption');
      if (next.caption !== before.caption) {
        caption?.remove();
        if (next.caption)
          figure.append(h('figcaption', { class: 'pm-frame-caption' }, next.caption));
      }
      if (same(next.settings, before.settings)) return true;
      // What the page asked for is on screen already; anything else it has to load.
      const known = shown && same(next.settings, shown);
      shown = undefined;
      if (!known) void show().catch(fail);
      return true;
    },
  };
}
