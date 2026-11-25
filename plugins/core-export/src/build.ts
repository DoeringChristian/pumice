import type { FramesApi, ReaderApi, VaultPath } from '@pumice/api';
import { extensionFor, pageHtml, rewriteCssUrls } from './page';
import { RUNTIME_JS } from './runtime.generated';

/**
 * Writes one note out as a page.
 *
 * The note is rendered as the app shows it (off screen), and what it shows is then made to
 * stand on its own: pictures, videos and sounds become files beside the page (or part of it),
 * frames become documents inside the page that carry their scripts and data, and the app's
 * styles are written into the page with their fonts.
 */

export interface Built {
  html: string;
  /** Files the page loads, by their path relative to it (empty when everything is inside). */
  files: Map<string, Uint8Array>;
}

export interface BuildOptions {
  path: VaultPath;
  title: string;
  markdown: string;
  reader: ReaderApi;
  frames: FramesApi | undefined;
  /**
   * `page`: to be read on a screen, with videos that play and frames that work.
   * `print`: for paper: a video is the picture it shows, and the light theme is used.
   */
  kind: 'page' | 'print';
  /** Everything inside the one HTML file (no files beside it). */
  inline: boolean;
  /** Where the videos of the note stand in the app right now, in order (for `print`). */
  videoTimes?: number[];
}

async function bytesOf(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read ${url.slice(0, 80)}`);
  const blob = await response.blob();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
}

function base64(bytes: Uint8Array): string {
  // In pieces whose length is a multiple of three, so they join without padding between.
  let out = '';
  const step = 0x8000 * 3;
  for (let i = 0; i < bytes.length; i += step) {
    let binary = '';
    const piece = bytes.subarray(i, i + step);
    for (let j = 0; j < piece.length; j += 0x8000)
      binary += String.fromCharCode(...piece.subarray(j, j + 0x8000));
    out += btoa(binary);
  }
  return out;
}

function dataUrl(bytes: Uint8Array, type: string): string {
  return `data:${type || 'application/octet-stream'};base64,${base64(bytes)}`;
}

/**
 * What the page loads is written under another name until the page is put together: here in
 * the app nothing of it should be loaded (or run) a second time.
 */
const SRC = 'data-pm-src';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until what the note shows is there: pictures loaded, videos readable, frames up. */
async function settled(root: HTMLElement, limit = 10000): Promise<void> {
  const started = Date.now();
  const pending = () =>
    [...root.querySelectorAll('img')].some((img) => !img.complete) ||
    [...root.querySelectorAll('video')].some((v) => v.readyState < 2 && !v.error) ||
    [...root.querySelectorAll('.pm-frame')].some(
      (f) => !f.querySelector('iframe, .pm-frame-error'),
    );
  // What is embedded is put in a moment after the text.
  await sleep(250);
  while (pending() && Date.now() - started < limit) await sleep(100);
  await sleep(250);
}

export async function buildPage(opts: BuildOptions): Promise<Built> {
  const files = new Map<string, Uint8Array>();
  const known = new Map<string, string>();
  let count = 0;
  /** A file of the page (or, inline, an address that holds it). */
  const asset = (bytes: Uint8Array, type: string, name: string, fallback: string): string => {
    if (opts.inline) return dataUrl(bytes, type);
    const path = `assets/${name}-${++count}.${extensionFor(type, fallback)}`;
    files.set(path, bytes);
    return path;
  };
  /**
   * Videos, sounds and documents inside the one file are kept as text beside the page's
   * content and made into something that can be played (and sought in) when the page opens.
   */
  const media: { id: string; type: string; base64: string }[] = [];
  const mediaIds = new Map<string, string>();
  /** Says on `el` where its media comes from: kept in the page, or a file beside it. */
  const playable = async (el: Element, url: string, name: string, fallback: string) => {
    if (!opts.inline) return el.setAttribute('data-pm-file', await assetOf(url, name, fallback));
    let id = mediaIds.get(url);
    if (!id) {
      const { bytes, type } = await bytesOf(url);
      id = `pm-media-${media.length + 1}`;
      media.push({ id, type: type || 'application/octet-stream', base64: base64(bytes) });
      mediaIds.set(url, id);
    }
    el.setAttribute('data-pm-media', id);
  };
  /** The same for something the app shows from an address; the same address once only. */
  const assetOf = async (url: string, name: string, fallback: string): Promise<string> => {
    const had = known.get(url);
    if (had) return had;
    const { bytes, type } = await bytesOf(url);
    const address = asset(bytes, type, name, fallback);
    known.set(url, address);
    return address;
  };

  // Off screen, as wide as a page: frames and videos only come up in the document.
  const stage = document.createElement('div');
  stage.style.cssText =
    'position:fixed;left:-20000px;top:0;width:700px;pointer-events:none;visibility:hidden';
  const root = document.createElement('div');
  root.className = 'pm-rendered pm-export-page';
  stage.append(root);
  document.body.append(stage);
  const rendered = await opts.reader.render(root, opts.markdown, {
    sourcePath: opts.path,
    numbered: true,
  });
  try {
    await settled(root);
    const missing = (text: string) => {
      const el = document.createElement('p');
      el.className = 'pm-export-missing';
      el.textContent = text;
      return el;
    };

    // Frames: each a document of its own inside the page.
    for (const figure of root.querySelectorAll<HTMLElement>('figure.pm-frame')) {
      const live = figure.querySelector('iframe');
      if (!live) continue;
      const html = await opts.frames
        ?.exportHtml(figure, { light: opts.kind === 'print' })
        .catch(() => undefined);
      if (html === undefined) {
        live.replaceWith(missing('(A frame that could not be written out.)'));
        continue;
      }
      const frame = document.createElement('iframe');
      frame.className = 'pm-frame-view';
      frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
      frame.setAttribute('allow', 'fullscreen');
      if (live.title) frame.title = live.title;
      const height = live.style.height || `${Math.round(live.getBoundingClientRect().height)}px`;
      frame.style.height = parseFloat(height) > 0 ? height : '320px';
      // A height the note gives is kept; else the frame says how tall it is.
      if (live.dataset.fixed !== undefined) frame.dataset.fixed = '';
      // Under another name until the page is written: here in the app it must not run.
      frame.setAttribute('data-pm-srcdoc', html);
      live.replaceWith(frame);
    }

    // Videos: one that plays, or (for paper) the picture it shows.
    const videos = [...root.querySelectorAll('video')];
    for (const [i, video] of videos.entries()) {
      const holder = video.closest<HTMLElement>('.pm-video') ?? video;
      const src = video.currentSrc || video.src;
      try {
        if (opts.kind === 'print') {
          const at = opts.videoTimes?.length === videos.length ? opts.videoTimes[i]! : 0;
          holder.replaceWith(await stillOf(video, at, asset));
        } else {
          // A place for the app's own player, which the page puts there as it opens.
          const slot = document.createElement('span');
          slot.className = 'pm-export-video';
          await playable(slot, src, 'video', 'mp4');
          if (video.loop) slot.setAttribute('data-loop', '');
          if (video.classList.contains('pm-embed-media')) slot.setAttribute('data-embed', '');
          const shown = video.getBoundingClientRect();
          // The room the player will take, so the page does not jump as it comes up.
          if (shown.width > 0 && shown.height > 0)
            slot.style.aspectRatio = `${Math.round(shown.width)} / ${Math.round(shown.height)}`;
          // A box with a size is filled (see `sizeEmbed`); without one it is as large as it is.
          slot.style.width = widthOf(video);
          slot.style.maxWidth = '100%';
          holder.replaceWith(slot);
        }
      } catch {
        holder.replaceWith(missing('(A video that could not be written out.)'));
      }
    }
    for (const audio of root.querySelectorAll('audio')) {
      const src = audio.currentSrc || audio.src;
      if (opts.kind === 'print') audio.replaceWith(missing('(A sound recording.)'));
      else if (src && !opts.inline) {
        const address = await assetOf(src, 'audio', 'mp3').catch(() => undefined);
        if (address) (audio.removeAttribute('src'), audio.setAttribute(SRC, address));
      } else if (src) {
        await playable(audio, src, 'audio', 'mp3').then(
          () => audio.removeAttribute('src'),
          () => undefined,
        );
      }
    }
    // What is drawn on a canvas, as the picture it is now.
    for (const canvas of root.querySelectorAll('canvas')) {
      try {
        const img = document.createElement('img');
        img.setAttribute(SRC, canvas.toDataURL('image/png'));
        img.style.cssText = canvas.style.cssText;
        canvas.replaceWith(img);
      } catch {
        // A canvas that may not be read stays as it is (empty on the page).
      }
    }
    for (const img of root.querySelectorAll('img')) {
      const src = img.currentSrc || img.src;
      if (!/^blob:/i.test(src)) continue;
      img.removeAttribute('srcset');
      const address = await assetOf(src, 'image', 'png').catch(() => undefined);
      if (address) (img.removeAttribute('src'), img.setAttribute(SRC, address));
    }
    // Another document shown in the note (a PDF).
    for (const frame of root.querySelectorAll<HTMLIFrameElement>('iframe:not(.pm-frame-view)')) {
      const src = frame.src;
      if (!/^blob:/i.test(src)) continue;
      if (opts.kind === 'print') frame.replaceWith(missing('(An embedded document.)'));
      else if (!opts.inline) {
        const address = await assetOf(src, 'document', 'pdf').catch(() => undefined);
        if (address) (frame.removeAttribute('src'), frame.setAttribute(SRC, address));
      } else {
        await playable(frame, src, 'document', 'pdf').then(
          () => frame.removeAttribute('src'),
          () => undefined,
        );
      }
    }
    // Links to other notes lead nowhere outside the app; those to a heading or a named place of
    // this note (a table of contents, `[[#Heading]]`, `[[#name]]`) lead to it.
    let anchors = 0;
    for (const link of root.querySelectorAll<HTMLElement>('a.internal-link')) {
      const heading = !link.dataset.target && link.dataset.subpath;
      const target = heading
        ? ([...root.querySelectorAll<HTMLElement>('[data-heading]')].find(
            (el) => el.dataset.heading === heading,
          ) ??
          [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find(
            (el) => el.dataset.blockId === heading.replace(/^\^/, ''),
          ))
        : undefined;
      if (target) {
        target.id ||= `heading-${++anchors}`;
        link.setAttribute('href', `#${target.id}`);
      } else link.removeAttribute('href');
    }
    for (const box of root.querySelectorAll('input[type="checkbox"]'))
      box.setAttribute('disabled', '');
    for (const el of root.querySelectorAll('[contenteditable]'))
      el.removeAttribute('contenteditable');
    for (const el of root.querySelectorAll('button')) el.remove();

    // The note's name over it, as in the app, unless the note starts with a title itself.
    const first = root.firstElementChild;
    if (first?.tagName !== 'H1') {
      const title = document.createElement('h1');
      title.className = 'pm-export-title';
      title.textContent = opts.title;
      root.prepend(title);
    }

    const css = await appCss(!!root.querySelector('.katex'), async (url) => {
      const { bytes, type } = await bytesOf(url);
      const had = known.get(url);
      if (had) return had;
      const address = asset(bytes, type, 'font', url.split(/[?#]/)[0]!.split('.').pop() ?? 'woff2');
      known.set(url, address);
      return address;
    });
    const style = getComputedStyle(document.documentElement);
    const dark = opts.kind === 'page' && style.colorScheme.trim().startsWith('dark');
    return {
      html: pageHtml({
        title: opts.title,
        body: root.innerHTML.replace(/ data-pm-(src|srcdoc)="/g, ' $1="'),
        css,
        // The theme the app shows now (paper is light), whatever the reader's system says.
        rootAttributes: {
          'data-theme': dark ? 'dark' : 'light',
          'data-exported-theme': dark ? 'dark' : 'light',
        },
        // On paper nothing plays and nothing is switched.
        ...(opts.kind === 'page'
          ? {
              runtime: {
                script: RUNTIME_JS,
                config: opts.frames?.themeKeys() ?? {
                  vars: [],
                  series: { light: [], dark: [] },
                },
                media,
              },
            }
          : {}),
      }),
      files,
    };
  } finally {
    rendered.dispose();
    stage.remove();
  }
}

/** The picture a video shows at a time, as an image. */
async function stillOf(
  video: HTMLVideoElement,
  at: number,
  asset: (bytes: Uint8Array, type: string, name: string, fallback: string) => string,
): Promise<HTMLImageElement> {
  const target = Math.min(Math.max(at, 0.05), Math.max(0.05, (video.duration || 1) - 0.05));
  if (Math.abs(video.currentTime - target) > 0.01) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener('seeked', done, { once: true });
      setTimeout(done, 3000);
      video.currentTime = target;
    });
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.9),
  );
  if (!blob) throw new Error('No picture');
  const img = document.createElement('img');
  img.setAttribute(
    SRC,
    asset(new Uint8Array(await blob.arrayBuffer()), 'image/jpeg', 'video-still', 'jpg'),
  );
  img.alt = 'Video';
  // (Sized by the box it is in, as the video was.)
  img.className = video.classList.contains('pm-embed-media') ? 'pm-embed-media' : '';
  img.style.width = widthOf(video);
  img.style.maxWidth = '100%';
  return img;
}

/** How wide a video stands in the page: as in the note. */
function widthOf(video: HTMLVideoElement): string {
  if (video.closest('.pm-embed.is-sized')) return '100%';
  const width = Number(video.getAttribute('width')) || video.videoWidth;
  return width ? `${width}px` : '100%';
}

/**
 * The app's styles as text, with the fonts and pictures they load handed to `load` (which
 * gives the address to use instead). The fonts of formulas only come along when there are
 * formulas.
 */
async function appCss(formulas: boolean, load: (url: string) => Promise<string>): Promise<string> {
  const parts: string[] = [];
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRule[];
    try {
      rules = [...sheet.cssRules];
    } catch {
      // A sheet from elsewhere may not be read.
      continue;
    }
    const base = sheet.href ?? document.baseURI;
    for (const rule of rules) {
      let text = rule.cssText;
      if (rule instanceof CSSFontFaceRule && /KaTeX/i.test(rule.style.fontFamily) && !formulas)
        continue;
      // A font is offered in several formats: the first one (the smallest) is enough.
      if (rule instanceof CSSFontFaceRule) {
        const src = rule.style.getPropertyValue('src');
        const first = /^\s*url\((?:"[^"]*"|'[^']*'|[^)]*)\)(?:\s*format\([^)]*\))?/.exec(src)?.[0];
        if (first && src && text.includes(src)) text = text.replace(src, first.trim());
      }
      if (!text.includes('url(')) {
        parts.push(text);
        continue;
      }
      parts.push(
        await rewriteCssUrls(text, async (url) => {
          try {
            return await load(new URL(url, base).href);
          } catch {
            return undefined;
          }
        }),
      );
    }
  }
  return parts.join('\n');
}
