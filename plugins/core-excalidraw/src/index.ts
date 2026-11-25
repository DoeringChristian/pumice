import {
  Documents,
  Drawings,
  Editor,
  FileLocations,
  Links,
  MarkdownSyntax,
  MetadataIndex,
  Reader,
  ShellService,
  Vault,
  Workspace,
  definePlugin,
  dirname,
  type DrawingsApi,
  type PluginModule,
  type ViewInstance,
} from '@pumice/api';
import manifestJson from '../manifest.json';
import { excalidrawCodec } from './codec';
import { drawingMetadata, drawingSearchText } from './extract';
import {
  applyDrawingOps,
  describeDrawing,
  estimateText,
  type DrawingOp,
  type MeasureText,
} from './agent';
import { isDrawingPath, newDrawing, parseDrawing, serializeDrawing } from './format';
import type { DrawingServices } from './services';
import './excalidraw.css';

export { excalidrawCodec, elementsMap, wins } from './codec';
export * from './format';
export { drawingMetadata } from './extract';
export * from './agent';

export const manifest = manifestJson;

type ViewModule = typeof import('./view');
let viewModule: Promise<ViewModule> | undefined;
// Fonts are served by the app (see packages/app/build/excalidraw-assets.ts), not a CDN.
(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH ??= new URL(
  './excalidraw/',
  document.baseURI,
).href;
/** The Excalidraw library is a separate chunk, loaded when a drawing is first shown. */
const loadView = () => (viewModule ??= import('./view'));

async function hash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** The longer side of the picture an agent is given of a drawing, at most. */
const PICTURE_SIDE = 1500;

/**
 * How large a text is in the drawing font: measured where the font is there (once a drawing
 * has been shown), guessed otherwise. The library lays the text out again when it is edited.
 */
const measureText: MeasureText = (text, fontSize) => {
  const guess = estimateText(text, fontSize);
  try {
    const font = `${fontSize}px Excalifont`;
    if (!document.fonts.check(font)) return guess;
    const canvas = document.createElement('canvas').getContext('2d');
    if (!canvas) return guess;
    canvas.font = font;
    const width = Math.max(...text.split('\n').map((line) => canvas.measureText(line).width));
    return { width: Math.ceil(width), height: guess.height };
  } catch {
    return guess;
  }
};

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const drawings: DrawingsApi = {
      isDrawing: isDrawingPath,
      describe(path, text) {
        const drawing = parseDrawing(path, text);
        return describeDrawing(drawing.scene, drawing.embedded);
      },
      edit(path, text, operations, options) {
        if (!isDrawingPath(path))
          throw new Error('A drawing is a file that ends in ".excalidraw.md".');
        const drawing = parseDrawing(path, text ?? (path.endsWith('.md') ? newDrawing() : ''));
        const summary = applyDrawingOps(
          drawing.scene,
          operations as DrawingOp[],
          measureText,
          options,
        );
        return { text: serializeDrawing(drawing), summary };
      },
      async picture(path, text) {
        const { exportToPng, loadEmbeddedFiles } = await loadView();
        const drawing = parseDrawing(path, text);
        const files = await loadEmbeddedFiles(services, path, drawing.embedded);
        const blob = await exportToPng({
          elements: drawing.scene.elements.filter((e) => !e.isDeleted) as never,
          appState: drawing.scene.appState as never,
          files: Object.fromEntries(files.map((f) => [f.id, f])) as never,
          dark: false,
          background: '#ffffff',
        });
        // No larger than is of use: a model looks at about 1500 pixels a side.
        const image = await createImageBitmap(blob);
        const scale = Math.min(1, PICTURE_SIDE / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const c = canvas.getContext('2d')!;
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, canvas.width, canvas.height);
        c.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close();
        return canvas.toDataURL('image/png');
      },
    };
    ctx.provide(Drawings, drawings);
    const documents = ctx.use(Documents);
    const workspace = ctx.use(Workspace);
    const index = ctx.use(MetadataIndex);
    const syntax = ctx.use(MarkdownSyntax);

    const services: DrawingServices = {
      vault,
      documents,
      index,
      workspace,
      async openLink(target, sourcePath, subpath, newTab) {
        const links = ctx.tryUse(Links);
        if (links)
          return links.openLink(target, { sourcePath, newTab, ...(subpath ? { subpath } : {}) });
        const r = index.resolve(target, sourcePath);
        if (r) await workspace.openFile(r.file.path, { newTab, state: subpath ? { subpath } : {} });
      },
      attachmentPath: (source, name, extension) =>
        ctx.tryUse(FileLocations)?.attachmentPath(source, name, extension) ??
        vault.availablePath(dirname(source), name, extension),
      openExternal(url) {
        void ctx.tryUse(ShellService)?.openExternal(url);
      },
    };

    ctx.register(documents.registerCodec(excalidrawCodec()));
    ctx.register(
      index.registerExtractor({
        id: 'excalidraw',
        extensions: ['excalidraw.md', 'excalidraw'],
        extract: (path, text) => drawingMetadata(path, text, (head) => syntax.extract(head)),
        searchText: drawingSearchText,
      }),
    );

    const views = new Set<import('./view').ExcalidrawView>();
    ctx.register(
      workspace.registerView({
        type: 'excalidraw',
        title: 'Drawing',
        icon: 'pen-tool',
        async create(viewCtx, state) {
          const { ExcalidrawView } = await loadView();
          const view = new ExcalidrawView(viewCtx, services);
          views.add(view);
          await view.setState(state);
          const dispose = view.dispose.bind(view);
          view.dispose = () => {
            views.delete(view);
            dispose();
          };
          return view as ViewInstance;
        },
      }),
    );
    ctx.register(
      workspace.registerFileHandler({
        viewType: 'excalidraw',
        extensions: ['excalidraw.md', 'excalidraw'],
      }),
    );

    // Embeds: ![[drawing]] renders as SVG, cached by content hash.
    const reader = ctx.tryUse(Reader);
    if (reader) {
      ctx.register(
        reader.registerEmbedRenderer({
          id: 'excalidraw',
          extensions: ['excalidraw.md', 'excalidraw'],
          async render(embed) {
            const file = embed.file!;
            const text = await documents.read(file.path);
            const dark =
              document.documentElement.dataset.theme === 'dark' ||
              (document.documentElement.dataset.theme !== 'light' &&
                matchMedia('(prefers-color-scheme: dark)').matches);
            const key = `svg2:${await hash(`${dark ? 'd' : 'l'}${text}`)}`;
            let svg = await ctx.storage.get(key);
            if (!svg) {
              const { exportToSvg, loadEmbeddedFiles, isDefaultBackground } = await loadView();
              const drawing = parseDrawing(file.path, text);
              const files = await loadEmbeddedFiles(services, file.path, drawing.embedded);
              const el = await exportToSvg({
                elements: drawing.scene.elements.filter((e) => !e.isDeleted) as never,
                appState: drawing.scene.appState as never,
                files: Object.fromEntries(files.map((f) => [f.id, f])) as never,
                dark,
                ...(isDefaultBackground(drawing.scene.appState.viewBackgroundColor)
                  ? { background: false as const }
                  : {}),
              });
              svg = new XMLSerializer().serializeToString(el);
              void ctx.storage.set(key, svg);
            }
            // (Not a `div`: read again from an exported page it would end the paragraph it is in.)
            const holder = document.createElement('span');
            holder.className = 'pm-excalidraw-embed';
            holder.title = `${file.title} — click to open`;
            holder.innerHTML = svg;
            // A drawing with nothing in it yet has no size: something to see and to click on.
            if (!holder.querySelector('svg > :not(defs):not(metadata):not(style)')) {
              holder.classList.add('is-empty');
              holder.textContent = `${file.title}: an empty drawing. Click to draw.`;
            }
            holder.querySelector('svg')?.classList.add('pm-embed-media');
            holder.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              void workspace.openFile(file.path, {
                newTab: e.metaKey || e.ctrlKey,
                ...(embed.subpath ? { state: { subpath: embed.subpath } } : {}),
              });
            });
            embed.container.append(holder);
          },
        }),
      );
    }

    const activeDrawing = () => [...views].find((v) => v.getState().path === workspace.activeFile);

    ctx.register(
      workspace.registerRibbonAction({
        id: 'excalidraw.new',
        icon: 'pen-tool',
        title: 'New drawing',
        order: 60,
        run: () => ctx.commands.execute('excalidraw.new'),
      }),
    );
    ctx.commands.register({
      id: 'excalidraw.new',
      title: 'Create new drawing',
      category: 'Excalidraw',
      run: async () => {
        const active = workspace.activeFile;
        const source = active && vault.get(active) ? active : undefined;
        const path =
          ctx.tryUse(FileLocations)?.drawingPath(source, 'drawing') ??
          vault.availablePath(source ? dirname(source) : '', 'drawing', 'excalidraw.md');
        await vault.create(path, newDrawing());
        await workspace.openFile(path);
      },
    });
    // Draw inside a note: a new drawing next to the note, embedded at the cursor.
    const insertDrawing = async () => {
      const editor = ctx.tryUse(Editor);
      const active = editor?.active();
      if (!editor || !active) return;
      const noteName = (active.path.split('/').pop() ?? 'Note').replace(/\.[^.]+$/, '');
      const path =
        ctx.tryUse(FileLocations)?.drawingPath(active.path, `${noteName} drawing`) ??
        vault.availablePath(dirname(active.path), `${noteName} drawing`, 'excalidraw.md');
      await vault.create(path, newDrawing());
      // As Obsidian writes it: `![[Name.excalidraw]]`.
      const embed = `![[${(path.split('/').pop() ?? '').replace(/\.md$/i, '')}]]`;
      const { state } = active.view;
      const line = state.doc.lineAt(state.selection.main.head);
      // On its own line, so it renders as a block.
      const lead = line.text.trim() ? '\n\n' : '';
      active.view.dispatch({
        changes: {
          from: line.text.trim() ? line.to : line.from,
          to: line.to,
          insert: `${lead}${embed}\n`,
        },
        userEvent: 'input',
      });
      await workspace.openFile(path, { newTab: true });
    };
    ctx.commands.register({
      id: 'excalidraw.insert',
      title: 'Insert new drawing into note',
      category: 'Excalidraw',
      hotkeys: ['Mod+Alt+D'],
      when: () => !!ctx.tryUse(Editor)?.active(),
      run: insertDrawing,
    });
    const editorApi = ctx.tryUse(Editor);
    if (editorApi) {
      ctx.register(
        editorApi.registerContextMenuItem({
          id: 'excalidraw.insert',
          label: 'Insert drawing',
          icon: 'pen-tool',
          order: 31,
          when: (v) => !v.state.readOnly,
          run: insertDrawing,
        }),
      );
      ctx.register(
        editorApi.registerToolbarAction({
          id: 'excalidraw.insert',
          title: 'Insert drawing',
          icon: 'pen-tool',
          order: 71,
          run: () => void insertDrawing(),
        }),
      );
    }
    for (const kind of ['svg', 'png'] as const) {
      ctx.commands.register({
        id: `excalidraw.export-${kind}`,
        title: `Export drawing as ${kind.toUpperCase()}`,
        category: 'Excalidraw',
        when: () => !!activeDrawing(),
        run: async () => {
          const path = await activeDrawing()?.export(kind);
          if (path) workspace.notify(`Exported to ${path}`);
        },
      });
    }
    ctx.commands.register({
      id: 'excalidraw.open-as-markdown',
      title: 'Open drawing as markdown',
      category: 'Excalidraw',
      when: () =>
        !!workspace.activeFile &&
        isDrawingPath(workspace.activeFile) &&
        workspace.activeFile.endsWith('.md'),
      run: () => workspace.openView('markdown', { state: { path: workspace.activeFile } }),
    });
    ctx.commands.register({
      id: 'excalidraw.open-as-drawing',
      title: 'Open as drawing',
      category: 'Excalidraw',
      when: () => !!workspace.activeFile && isDrawingPath(workspace.activeFile) && !activeDrawing(),
      run: () => workspace.openView('excalidraw', { state: { path: workspace.activeFile } }),
    });
  },
});

export default { manifest, plugin } satisfies PluginModule;
