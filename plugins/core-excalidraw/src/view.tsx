/**
 * The drawing view. This module (and with it the Excalidraw library) is loaded on first use.
 */
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  ensureSubtypesLoadedForElements,
  exportScene,
  registerMathSubtype,
  useMathSubtype,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type {
  ExcalidrawImperativeAPI,
  BinaryFileData,
  BinaryFiles,
  AppState,
} from '@excalidraw/excalidraw/types';
import type {
  OrderedExcalidrawElement,
  ExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import {
  basename,
  dirname,
  parseWikiLinkContent,
  type DocumentHandle,
  type ViewContext,
  type ViewInstance,
  type ViewState,
} from '@pumice/api';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as Y from 'yjs';
import { ORIGIN_DRAWING_LOAD, elementsMap, readDrawing, wins } from './codec';
import type { DrawingElement } from './format';
import type { DrawingServices } from './services';

const ORIGIN_VIEW = 'pumice:excalidraw-view';

// LaTeX/AsciiMath text (the fork's `math` subtype, docs/plan/09): registered up front so
// exports and embeds render math even without an open editor.
registerMathSubtype();

interface ExportInput {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  dark?: boolean;
  /** Canvas background; `false` = transparent. Default: the scene's own background. */
  background?: string | false;
}

/**
 * Drawings with the default (white) background take the app's background instead, in the view
 * and in embeds: the canvas is transparent and the page shows through. A background the user
 * picked is kept. The file keeps saying white, so other apps see no change.
 */
export const isDefaultBackground = (color: unknown) =>
  typeof color !== 'string' || /^(#fff(fff)?|white|transparent)$/i.test(color.trim());
const shownBackground = (color: unknown) =>
  isDefaultBackground(color) ? 'transparent' : (color as string);

const exportData = (o: ExportInput) => ({
  elements: o.elements.filter((e) => !e.isDeleted) as never,
  appState: o.appState as never,
  files: o.files,
});

/** SVG of a scene, after loading the subtypes (MathJax) its elements use. */
async function exportToSvg(o: ExportInput): Promise<SVGSVGElement> {
  await ensureSubtypesLoadedForElements(o.elements);
  return exportScene({
    type: 'svg',
    data: exportData(o),
    config: {
      theme: o.dark ? 'dark' : 'light',
      ...(o.background !== undefined ? { canvasBackgroundColor: o.background } : {}),
    },
  });
}

async function exportToPng(o: ExportInput): Promise<Blob> {
  await ensureSubtypesLoadedForElements(o.elements);
  return exportScene({
    type: 'png',
    data: exportData(o),
    config: {
      theme: o.dark ? 'dark' : 'light',
      ...(o.background !== undefined ? { canvasBackgroundColor: o.background } : {}),
    },
  });
}
const SHARED_APP_STATE = [
  'viewBackgroundColor',
  'gridSize',
  'gridStep',
  'gridModeEnabled',
] as const;

function currentTheme(): 'light' | 'dark' {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const update = () => setTheme(currentTheme());
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      media.removeEventListener('change', update);
      observer.disconnect();
    };
  }, []);
  return theme;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function dataUrlToBytes(dataURL: string): { bytes: Uint8Array; mime: string } {
  const [header, data = ''] = dataURL.split(',');
  const mime = /data:([^;]+)/.exec(header ?? '')?.[1] ?? 'application/octet-stream';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime };
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Loads vault images referenced in the Embedded Files section as Excalidraw files. */
export async function loadEmbeddedFiles(
  services: DrawingServices,
  sourcePath: string,
  embedded: Record<string, string>,
): Promise<BinaryFileData[]> {
  const out: BinaryFileData[] = [];
  for (const [id, link] of Object.entries(embedded)) {
    const inner = /\[\[([^\]]+)\]\]/.exec(link)?.[1];
    if (!inner) continue;
    const target = services.index.resolve(parseWikiLinkContent(inner).target, sourcePath)?.file;
    if (!target) continue;
    try {
      const bytes = await services.vault.readBinary(target.path);
      const ext = target.extension.toLowerCase();
      const mime = Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] ?? 'image/png';
      out.push({
        id: id as BinaryFileData['id'],
        mimeType: mime as BinaryFileData['mimeType'],
        dataURL: bytesToDataUrl(bytes, mime) as BinaryFileData['dataURL'],
        created: target.mtime,
      });
    } catch {
      // missing image: Excalidraw shows a placeholder
    }
  }
  return out;
}

export class ExcalidrawView implements ViewInstance {
  private root: Root | undefined;
  private handle: DocumentHandle | undefined;
  private api: ExcalidrawImperativeAPI | undefined;
  private readonly known = new Map<string, number>();
  private readonly savedFiles = new Set<string>();
  private unobserve: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly ctx: ViewContext,
    private readonly services: DrawingServices,
  ) {
    ctx.container.classList.add('pm-excalidraw-view');
  }

  async setState(state: ViewState): Promise<void> {
    if (!state.path || state.path === this.handle?.path) {
      if (typeof state.subpath === 'string') this.revealElement(state.subpath);
      return;
    }
    const handle = await this.services.documents.open(state.path);
    if (this.disposed) {
      handle.dispose();
      return;
    }
    this.release();
    this.handle = handle;
    this.ctx.setFile(handle.path);
    this.ctx.setTitle(basename(handle.path).replace(/\.excalidraw(\.md)?$/i, ''));
    handle.onDidRename((p) => {
      this.ctx.setFile(p);
      this.ctx.setTitle(basename(p).replace(/\.excalidraw(\.md)?$/i, ''));
    });
    handle.onDidDelete(() => this.services.workspace.closeFile(handle.path));
    await this.mount(handle, typeof state.subpath === 'string' ? state.subpath : undefined);
  }

  getState(): ViewState {
    return { path: this.handle?.path };
  }

  focus(): void {
    this.ctx.container.querySelector<HTMLElement>('.excalidraw')?.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.release();
  }

  /** Exports the current drawing next to the file. */
  async export(kind: 'svg' | 'png'): Promise<string | undefined> {
    const api = this.api;
    const handle = this.handle;
    if (!api || !handle) return undefined;
    const elements = api.getSceneElements();
    const appState = api.getAppState();
    const files = api.getFiles();
    // Exported files get a real background (the view's default one is transparent).
    const background = isDefaultBackground(appState.viewBackgroundColor)
      ? '#ffffff'
      : appState.viewBackgroundColor;
    const base = handle.path.replace(/\.excalidraw(\.md)?$/i, '');
    if (kind === 'svg') {
      const svg = await exportToSvg({ elements, appState, files, background });
      const path = `${base}.svg`;
      await this.services.vault.write(path, new XMLSerializer().serializeToString(svg));
      return path;
    }
    const blob = await exportToPng({ elements, appState, files, background });
    const path = `${base}.png`;
    await this.services.vault.write(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  }

  private release(): void {
    this.unobserve?.();
    this.unobserve = undefined;
    this.root?.unmount();
    this.root = undefined;
    this.api = undefined;
    this.handle?.dispose();
    this.handle = undefined;
    this.known.clear();
  }

  private revealElement(subpath: string): void {
    const id = subpath.replace(/^\^/, '');
    const el = this.api?.getSceneElements().find((e) => e.id === id);
    if (el && this.api) this.api.setViewport({ target: el, fit: 'scale-down', animation: true });
  }

  private async mount(handle: DocumentHandle, subpath: string | undefined): Promise<void> {
    const doc = handle.doc;
    const drawing = readDrawing(doc);
    const elements = drawing.scene.elements.filter((e) => !e.isDeleted);
    for (const e of drawing.scene.elements) this.known.set(e.id, e.version);
    const files = await loadEmbeddedFiles(this.services, handle.path, drawing.embedded);
    for (const f of Object.values(drawing.scene.files) as BinaryFileData[]) files.push(f);
    for (const id of Object.keys(drawing.embedded)) this.savedFiles.add(id);

    const container = document.createElement('div');
    container.className = 'pm-excalidraw-host';
    this.ctx.container.replaceChildren(container);
    this.root = createRoot(container);

    const View = () => {
      const theme = useTheme();
      const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
      useMathSubtype(api);
      return (
        <Excalidraw
          theme={theme}
          initialData={{
            elements: elements as unknown as ExcalidrawElement[],
            appState: {
              ...drawing.scene.appState,
              viewBackgroundColor: shownBackground(drawing.scene.appState.viewBackgroundColor),
              theme,
            },
            files: Object.fromEntries(files.map((f) => [f.id, f])) as BinaryFiles,
            scrollToContent: true,
          }}
          onExcalidrawAPI={(api) => {
            if (!api) return;
            this.api = api;
            setApi(api);
            // Loaded after the tab was activated: take the keyboard if the drawing is on screen.
            if (container.offsetParent !== null && !container.contains(document.activeElement))
              setTimeout(() => this.focus(), 0);
            if (subpath) setTimeout(() => this.revealElement(subpath), 50);
          }}
          onChange={(els, appState, binaryFiles) => this.onChange(els, appState, binaryFiles)}
          onLinkOpen={(element, event) => {
            const link = element.link ?? '';
            const m = /^\[\[([^\]]+)\]\]$/.exec(link.trim());
            if (m) {
              event.preventDefault();
              const parts = parseWikiLinkContent(m[1]!);
              void this.services.openLink(
                parts.target,
                handle.path,
                parts.subpath,
                event.detail.nativeEvent.shiftKey,
              );
            } else if (/^https?:/i.test(link)) {
              event.preventDefault();
              this.services.openExternal(link);
            }
          }}
          UIOptions={{
            // Excalidraw's own desktop interface (full style panel) even in a pane narrowed
            // by sidebars; its tablet layout would replace the panel with an icon column.
            getFormFactor: (width) => (width < 640 ? 'phone' : 'desktop'),
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              export: { saveFileToDisk: true },
            },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      );
    };
    this.root.render(
      <StrictMode>
        <View />
      </StrictMode>,
    );

    // Changes from elsewhere (disk merge, other editors of the same doc, collaborators).
    const map = elementsMap(doc);
    const onElements = (_e: Y.YMapEvent<DrawingElement>, tr: Y.Transaction) => {
      if (tr.origin === ORIGIN_VIEW || !this.api) return;
      this.applyRemote(tr.origin === ORIGIN_DRAWING_LOAD);
    };
    map.observe(onElements);
    const meta = doc.getMap<unknown>('meta');
    const onMeta = (_e: Y.YMapEvent<unknown>, tr: Y.Transaction) => {
      if (tr.origin === ORIGIN_VIEW || !this.api) return;
      const state: Record<string, unknown> = {};
      for (const key of SHARED_APP_STATE) if (meta.has(key)) state[key] = meta.get(key);
      if ('viewBackgroundColor' in state)
        state.viewBackgroundColor = shownBackground(state.viewBackgroundColor);
      this.api.updateScene({
        appState: state as unknown as AppState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    meta.observe(onMeta);
    this.unobserve = () => {
      map.unobserve(onElements);
      meta.unobserve(onMeta);
    };
  }

  private applyRemote(reloadFiles: boolean): void {
    const api = this.api;
    const handle = this.handle;
    if (!api || !handle) return;
    const map = elementsMap(handle.doc);
    const local = new Map(
      api.getSceneElementsIncludingDeleted().map((e) => [e.id, e as unknown as DrawingElement]),
    );
    const merged: DrawingElement[] = [];
    for (const [id, remote] of map) {
      const mine = local.get(id);
      merged.push(wins(remote, mine) ? remote : mine!);
      this.known.set(id, Math.max(this.known.get(id) ?? 0, remote.version));
      local.delete(id);
    }
    // Elements removed from the doc (external deletion) disappear unless edited meanwhile.
    for (const [id, mine] of local)
      if ((this.known.get(id) ?? -1) < mine.version) merged.push(mine);
    api.updateScene({
      elements: merged as unknown as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    if (reloadFiles) {
      void loadEmbeddedFiles(this.services, handle.path, readDrawing(handle.doc).embedded).then(
        (files) => api.addFiles(files),
      );
    }
  }

  private onChange(
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ): void {
    const handle = this.handle;
    if (!handle) return;
    // What is written over (a formula while it is edited) covers with the drawing's own
    // background: the app's, unless the drawing has one of its own.
    const background = appState.viewBackgroundColor;
    this.ctx.container.style.setProperty(
      '--pm-drawing-bg',
      !background || background === 'transparent' ? 'var(--bg)' : background,
    );
    const changed: DrawingElement[] = [];
    for (const el of elements) {
      if ((this.known.get(el.id) ?? -1) < el.version) {
        changed.push(JSON.parse(JSON.stringify(el)) as DrawingElement);
        this.known.set(el.id, el.version);
      }
    }
    const meta = handle.doc.getMap<unknown>('meta');
    const metaChanges: Array<[string, unknown]> = [];
    for (const key of SHARED_APP_STATE) {
      const value = appState[key as keyof AppState];
      // The transparent stand-in for the default background isn't saved.
      if (key === 'viewBackgroundColor' && value === 'transparent') continue;
      if (value !== undefined && JSON.stringify(meta.get(key)) !== JSON.stringify(value))
        metaChanges.push([key, value]);
    }
    if (changed.length || metaChanges.length) {
      const map = elementsMap(handle.doc);
      handle.doc.transact(() => {
        for (const el of changed) if (wins(el, map.get(el.id))) map.set(el.id, el);
        for (const [k, v] of metaChanges) meta.set(k, v);
      }, ORIGIN_VIEW);
    }
    for (const file of Object.values(files)) {
      if (!this.savedFiles.has(file.id)) {
        this.savedFiles.add(file.id);
        void this.saveFile(file);
      }
    }
  }

  /** Images pasted into the drawing become vault attachments (as the Obsidian plugin does). */
  private async saveFile(file: BinaryFileData): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    const { bytes, mime } = dataUrlToBytes(file.dataURL);
    const ext = MIME_EXT[mime] ?? 'png';
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const name = `Pasted Image ${stamp}`;
    const path =
      this.services.attachmentPath?.(handle.path, name, ext) ??
      this.services.vault.availablePath(dirname(handle.path), name, ext);
    await this.services.vault.create(path, bytes);
    handle.doc.transact(() => {
      handle.doc.getMap<string>('embedded').set(file.id, `[[${basename(path)}]]`);
    }, ORIGIN_VIEW);
  }
}

export { exportToPng, exportToSvg };
