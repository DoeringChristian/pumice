import {
  Vault,
  Workspace,
  basename,
  definePlugin,
  type PluginModule,
  type VaultPath,
  type ViewState,
} from '@pumice/api';
import { createIcon, h } from '@pumice/ui';
import manifestJson from '../manifest.json';
import './media.css';

export const manifest = manifestJson;

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
const AUDIO = ['mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp'];
const VIDEO = ['mp4', 'mov', 'mkv', 'ogv', 'webm'];
const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
};
const ext = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const mime = (e: string) =>
  MIME[e] ?? (IMAGE.includes(e) ? `image/${e}` : AUDIO.includes(e) ? `audio/${e}` : `video/${e}`);
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} kB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

export const plugin = definePlugin({
  activate(ctx) {
    const vault = ctx.use(Vault);
    const workspace = ctx.use(Workspace);

    ctx.register(
      workspace.registerView({
        type: 'media',
        title: 'Media',
        icon: 'image',
        create(view, initial) {
          const stage = h('div', { class: 'pm-media-stage', tabIndex: 0 });
          const info = h('span', { class: 'pm-media-info' });
          const zoomLabel = h('button', { class: 'pm-media-zoom-label', title: 'Fit to window' });
          const button = (icon: string, title: string, run: () => void) =>
            h(
              'button',
              { class: 'pm-icon-button', title, 'aria-label': title, onclick: run },
              createIcon(icon, 15),
            );
          const zoomTools = h(
            'div',
            { class: 'pm-media-tools' },
            button('minus', 'Zoom out', () => step(-1)),
            zoomLabel,
            button('plus', 'Zoom in', () => step(1)),
          );
          const bar = h('div', { class: 'pm-media-bar' }, info, zoomTools);
          view.container.append(h('div', { class: 'pm-media' }, bar, stage));

          let path: VaultPath | undefined;
          let url: string | undefined;
          let image: HTMLImageElement | undefined;
          /** null: fit the window; a number: that scale. */
          let zoom: number | null = null;
          let generation = 0;

          const fitScale = () => {
            if (!image?.naturalWidth) return 1;
            const pad = 32;
            return Math.min(
              1,
              (stage.clientWidth - pad) / image.naturalWidth,
              (stage.clientHeight - pad) / image.naturalHeight,
            );
          };
          const applyZoom = () => {
            if (!image) return;
            const scale = zoom ?? fitScale();
            image.style.width = `${Math.max(1, Math.round(image.naturalWidth * scale))}px`;
            zoomLabel.textContent =
              zoom === null ? `Fit (${Math.round(scale * 100)}%)` : `${Math.round(scale * 100)}%`;
            stage.classList.toggle('is-fit', zoom === null);
          };
          const step = (dir: 1 | -1) => {
            const current = zoom ?? fitScale();
            const next =
              dir > 0
                ? ZOOMS.find((z) => z > current + 0.001)
                : [...ZOOMS].reverse().find((z) => z < current - 0.001);
            if (next === undefined) return;
            zoom = next;
            applyZoom();
          };
          zoomLabel.addEventListener('click', () => {
            zoom = zoom === null ? 1 : null;
            applyZoom();
          });
          stage.addEventListener(
            'wheel',
            (e) => {
              // Pinch or Ctrl/Cmd+wheel zooms; plain scrolling pans.
              if (!image || !(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              const current = zoom ?? fitScale();
              zoom = Math.min(8, Math.max(0.05, current * Math.exp(-e.deltaY / 300)));
              applyZoom();
            },
            { passive: false },
          );
          stage.addEventListener('dblclick', () => {
            if (!image) return;
            zoom = zoom === null ? 1 : null;
            applyZoom();
          });
          const resize = new ResizeObserver(() => zoom === null && applyZoom());
          resize.observe(stage);

          const load = async (next: VaultPath | undefined) => {
            const gen = ++generation;
            path = next;
            if (url) URL.revokeObjectURL(url);
            url = undefined;
            image = undefined;
            zoom = null;
            stage.replaceChildren();
            if (!path) return;
            view.setFile(path);
            view.setTitle(basename(path));
            const e = ext(path);
            let bytes: Uint8Array;
            try {
              bytes = await vault.readBinary(path);
            } catch (err) {
              if (gen !== generation) return;
              stage.append(
                h(
                  'div',
                  { class: 'pm-media-error' },
                  `Could not open the file: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
              return;
            }
            if (gen !== generation) return;
            url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime(e) }));
            zoomTools.hidden = !IMAGE.includes(e);
            if (IMAGE.includes(e)) {
              const img = h('img', {
                class: 'pm-media-image',
                alt: basename(path),
                draggable: false,
              });
              img.addEventListener('load', () => {
                if (gen !== generation) return;
                image = img;
                info.textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${size(bytes.byteLength)}`;
                applyZoom();
              });
              img.addEventListener('error', () =>
                stage.replaceChildren(
                  h('div', { class: 'pm-media-error' }, 'This image can’t be displayed.'),
                ),
              );
              img.src = url;
              stage.append(img);
            } else if (AUDIO.includes(e)) {
              info.textContent = size(bytes.byteLength);
              stage.append(h('audio', { class: 'pm-media-audio', controls: true, src: url }));
            } else {
              info.textContent = size(bytes.byteLength);
              stage.append(h('video', { class: 'pm-media-video', controls: true, src: url }));
            }
          };

          // Reload when the file changes on disk (an exported drawing, a re-rendered plot, …).
          const sub = vault.onDidChange((changes) => {
            for (const c of changes) {
              if (c.type === 'modify' && c.entry.path === path) void load(path);
              if (c.type === 'rename' && c.oldPath === path) void load(c.entry.path);
            }
          });
          void load(typeof initial.path === 'string' ? initial.path : undefined);
          return {
            getState: (): ViewState => (path ? { path } : {}),
            setState: (state) => load(typeof state.path === 'string' ? state.path : undefined),
            focus: () => stage.focus(),
            dispose() {
              generation++;
              sub.dispose();
              resize.disconnect();
              if (url) URL.revokeObjectURL(url);
            },
          };
        },
      }),
    );
    ctx.register(
      workspace.registerFileHandler({
        viewType: 'media',
        extensions: [...IMAGE, ...AUDIO, ...VIDEO],
      }),
    );
  },
});

export default { manifest, plugin } satisfies PluginModule;
