import {
  Reader,
  Vault,
  Workspace,
  basename,
  definePlugin,
  type PluginModule,
  type VaultPath,
  type ViewState,
} from '@pumice/api';
import { createIcon, createVideoControls, h } from '@pumice/ui';
import '@pumice/ui/video.css';
import manifestJson from '../manifest.json';
import './media.css';

export const manifest = manifestJson;

const IMAGE = ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
const AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', '3gp'];
const VIDEO = ['mp4', 'm4v', 'mov', 'mkv', 'ogv', 'webm'];
const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jfif: 'image/jpeg',
  apng: 'image/apng',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4v: 'video/mp4',
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
          // A video's controls stay in place under the picture while it is zoomed and moved.
          const controls = h('div', { class: 'pm-media-controls', hidden: true });
          view.container.append(h('div', { class: 'pm-media' }, bar, stage, controls));

          let path: VaultPath | undefined;
          let url: string | undefined;
          /** The picture that is zoomed and moved: an image, or a video. */
          let image: HTMLImageElement | HTMLVideoElement | undefined;
          const natural = () =>
            image instanceof HTMLVideoElement
              ? { w: image.videoWidth, h: image.videoHeight }
              : { w: image?.naturalWidth ?? 0, h: image?.naturalHeight ?? 0 };
          /** null: fit the window; a number: that scale. */
          let zoom: number | null = null;
          let generation = 0;

          const fitScale = () => {
            const { w, h: height } = natural();
            if (!w || !height) return 1;
            const pad = 32;
            return Math.min(1, (stage.clientWidth - pad) / w, (stage.clientHeight - pad) / height);
          };
          const applyZoom = () => {
            if (!image) return;
            const scale = zoom ?? fitScale();
            image.style.width = `${Math.max(1, Math.round(natural().w * scale))}px`;
            zoomLabel.textContent =
              zoom === null ? `Fit (${Math.round(scale * 100)}%)` : `${Math.round(scale * 100)}%`;
            stage.classList.toggle('is-fit', zoom === null);
          };
          /**
           * Changes the zoom and keeps the point of the picture under (x, y) where it is on
           * screen. Without a point, the middle of the view stays put.
           */
          const zoomTo = (next: number | null, at?: { x: number; y: number }) => {
            if (!image) return;
            const view = stage.getBoundingClientRect();
            const x = at?.x ?? view.left + view.width / 2;
            const y = at?.y ?? view.top + view.height / 2;
            const before = image.getBoundingClientRect();
            const fx = (x - before.left) / before.width;
            const fy = (y - before.top) / before.height;
            zoom = next;
            applyZoom();
            const after = image.getBoundingClientRect();
            stage.scrollLeft += after.left + fx * after.width - x;
            stage.scrollTop += after.top + fy * after.height - y;
          };
          const step = (dir: 1 | -1) => {
            const current = zoom ?? fitScale();
            const next =
              dir > 0
                ? ZOOMS.find((z) => z > current + 0.001)
                : [...ZOOMS].reverse().find((z) => z < current - 0.001);
            if (next !== undefined) zoomTo(next);
          };
          zoomLabel.addEventListener('click', () => zoomTo(zoom === null ? 1 : null));
          stage.addEventListener(
            'wheel',
            (e) => {
              // Pinch or Ctrl/Cmd+wheel zooms at the pointer; plain scrolling pans.
              if (!image || !(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              const current = zoom ?? fitScale();
              const next = Math.min(16, Math.max(0.05, current * Math.exp(-e.deltaY / 200)));
              zoomTo(next, { x: e.clientX, y: e.clientY });
            },
            { passive: false },
          );
          stage.addEventListener('dblclick', (e) => {
            if (!image) return;
            zoomTo(zoom === null ? Math.max(1, fitScale() * 2) : null, {
              x: e.clientX,
              y: e.clientY,
            });
          });
          // Drag to move around a picture that is larger than the view.
          let drag: { x: number; y: number; left: number; top: number } | undefined;
          stage.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || !image) return;
            drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
            stage.setPointerCapture(e.pointerId);
            stage.classList.add('is-dragging');
          });
          stage.addEventListener('pointermove', (e) => {
            if (!drag) return;
            stage.scrollLeft = drag.left - (e.clientX - drag.x);
            stage.scrollTop = drag.top - (e.clientY - drag.y);
          });
          const endDrag = (e: PointerEvent) => {
            drag = undefined;
            stage.classList.remove('is-dragging');
            if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
          };
          stage.addEventListener('pointerup', endDrag);
          stage.addEventListener('pointercancel', endDrag);
          stage.addEventListener('keydown', (e) => {
            if (e.key === '+' || e.key === '=') step(1);
            else if (e.key === '-') step(-1);
            else if (e.key === '0') zoomTo(null);
            else if (e.key === '1') zoomTo(1);
            else if (e.key === ' ' && image instanceof HTMLVideoElement) {
              if (image.paused || image.ended) void image.play().catch(() => undefined);
              else image.pause();
            } else return;
            e.preventDefault();
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
            controls.replaceChildren();
            controls.hidden = true;
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
            zoomTools.hidden = !IMAGE.includes(e) && !VIDEO.includes(e);
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
              const video = h('video', {
                class: 'pm-media-video',
                src: url,
                preload: 'metadata',
                playsInline: true,
                loop: ctx.tryUse(Reader)?.loopVideos() ?? true,
              });
              video.addEventListener('loadedmetadata', () => {
                if (gen !== generation) return;
                image = video;
                info.textContent = `${video.videoWidth} × ${video.videoHeight} px · ${size(bytes.byteLength)}`;
                applyZoom();
              });
              video.addEventListener('error', () =>
                stage.replaceChildren(
                  h('div', { class: 'pm-media-error' }, 'This video can’t be played here.'),
                ),
              );
              stage.append(video);
              controls.append(createVideoControls(video));
              controls.hidden = false;
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
