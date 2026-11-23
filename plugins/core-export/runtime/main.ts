/**
 * What runs in an exported page, so that it behaves as the note does in the app: the app's
 * own video player and its enlarged view of pictures and videos, frames that follow the
 * theme, and a switch between light and dark.
 *
 * Built into `src/runtime.generated.ts` by `scripts/build-runtime.mjs` (run it after changing
 * this file or what it imports; a test checks that it was).
 */
import { showLightbox } from '../../core-reader/src/lightbox';
import { createVideoPlayer } from '../../../packages/ui/src/video';

interface Config {
  /** Names of the theme's variables that frames are given. */
  vars: string[];
  series: { light: string[]; dark: string[] };
}

const config: Config = JSON.parse(
  document.getElementById('pm-export-config')?.textContent ||
    '{"vars":[],"series":{"light":[],"dark":[]}}',
);

/** Media kept inside the page as text: made into something a player can seek in. */
async function media(id: string): Promise<string | undefined> {
  const holder = document.getElementById(id);
  if (!holder) return undefined;
  const type = holder.getAttribute('data-type') || 'application/octet-stream';
  const blob = await (await fetch(`data:${type};base64,${holder.textContent ?? ''}`)).blob();
  // The text is not needed twice.
  holder.textContent = '';
  return URL.createObjectURL(blob);
}
const sourceOf = async (el: Element): Promise<string | undefined> => {
  const kept = el.getAttribute('data-pm-media');
  return kept ? media(kept) : (el.getAttribute('data-pm-file') ?? undefined);
};

async function players(): Promise<void> {
  for (const slot of [...document.querySelectorAll<HTMLElement>('.pm-export-video')]) {
    const src = await sourceOf(slot).catch(() => undefined);
    if (!src) continue;
    const title = slot.getAttribute('data-title') ?? '';
    const { dom, video } = createVideoPlayer(src, {
      onClick: (shown) => showLightbox(shown.currentSrc || shown.src, title, shown),
    });
    video.loop = slot.hasAttribute('data-loop');
    const width = slot.getAttribute('data-width');
    // The width the note gives the player (its bar is as wide); without one it is as wide as
    // the text. Its height is the picture's and the bar's.
    const given = slot.getAttribute('data-holder-width') ?? (width ? `${Number(width)}px` : '');
    if (given) dom.style.width = given;
    dom.style.maxWidth = '100%';
    slot.replaceWith(dom);
  }
  for (const el of [
    ...document.querySelectorAll<HTMLElement>('audio[data-pm-media], iframe[data-pm-media]'),
  ]) {
    const src = await sourceOf(el).catch(() => undefined);
    if (src) el.setAttribute('src', src);
  }
}

function pictures(): void {
  document.addEventListener('click', (e) => {
    const img = (e.target as HTMLElement).closest?.('img.pm-zoomable');
    if (!(img instanceof HTMLImageElement) || img.closest('.pm-lightbox')) return;
    e.preventDefault();
    showLightbox(img.currentSrc || img.src, img.alt);
  });
}

/** The theme as frames get it, read from the page as it is now. */
function frameTheme() {
  const style = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme === 'dark';
  const vars: Record<string, string> = {};
  for (const name of config.vars) {
    const value = style.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  (dark ? config.series.dark : config.series.light).forEach(
    (c, i) => (vars[`--series-${i + 1}`] = c),
  );
  return { dark, vars };
}

const SUN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

function themeSwitch(): void {
  const KEY = 'pumice.export.theme';
  const root = document.documentElement;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pm-export-theme';
  const show = () => {
    const dark = root.dataset.theme === 'dark';
    button.innerHTML = dark ? SUN : MOON;
    button.title = dark ? 'Light' : 'Dark';
    button.setAttribute('aria-label', dark ? 'Switch to light' : 'Switch to dark');
  };
  const set = (theme: string, tell: boolean) => {
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    show();
    if (!tell) return;
    const theme_ = frameTheme();
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe.pm-frame-view'))
      frame.contentWindow?.postMessage({ type: 'pumice-theme', theme: theme_ }, '*');
  };
  let kept: string | null = null;
  try {
    kept = localStorage.getItem(KEY);
  } catch {
    // No storage for a page opened from a file in some browsers.
  }
  if (kept === 'dark' || kept === 'light') set(kept, false);
  else show();
  // Frames start with the theme the note was exported in: told once they are up.
  if (kept && kept !== root.getAttribute('data-exported-theme'))
    addEventListener('load', () => setTimeout(() => set(root.dataset.theme!, true), 300));
  button.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    set(next, true);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not kept, then.
    }
  });
  document.body.append(button);
}

themeSwitch();
pictures();
void players();
