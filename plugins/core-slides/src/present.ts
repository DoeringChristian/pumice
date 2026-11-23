import type { Disposable, ReaderApi, VaultPath } from '@pumice/api';
import { createIcon } from '@pumice/ui';
import { slideAt, splitSlides, type Slide } from './slides';

/** The size a slide is laid out at; it is scaled to the window as a whole. */
const WIDTH = 1280;
const HEIGHT = 720;

export interface Presentation {
  /** The note changed: its slides are read again; the one shown stays in place. */
  update(note: string): void;
  close(): void;
}

/**
 * Shows a note as slides over the whole window. Arrow keys, Space, Page Up/Down, a click or a
 * swipe move through them; Escape ends it.
 */
export function present(opts: {
  note: string;
  path: VaultPath;
  reader: ReaderApi;
  /** A place in the note: the presentation starts at its slide. */
  startAt?: number;
  onClose?: () => void;
}): Presentation {
  const { reader, path } = opts;
  let slides: Slide[] = splitSlides(opts.note);
  let index = slideAt(slides, opts.startAt ?? 0);
  let rendered: Disposable | undefined;
  let generation = 0;

  const overlay = document.createElement('div');
  overlay.className = 'pm-slides';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Presentation');
  const stage = document.createElement('div');
  stage.className = 'pm-slides-stage';
  const slide = document.createElement('div');
  slide.className = 'pm-slide';
  slide.setAttribute('aria-live', 'polite');
  const content = document.createElement('div');
  content.className = 'pm-slide-content pm-rendered';
  slide.append(content);
  stage.append(slide);

  const button = (icon: string, label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pm-slides-button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(createIcon(icon, 16));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
      overlay.focus();
    });
    return b;
  };
  const counter = document.createElement('span');
  counter.className = 'pm-slides-counter';
  const progress = document.createElement('div');
  progress.className = 'pm-slides-progress';
  const bar = document.createElement('div');
  bar.className = 'pm-slides-bar';
  bar.append(
    button('chevron-left', 'Previous slide (←)', () => go(index - 1)),
    counter,
    button('chevron-right', 'Next slide (→)', () => go(index + 1)),
    button('maximize', 'Full screen (F)', () => toggleFullscreen()),
    button('x', 'End the presentation (Esc)', () => close()),
  );
  overlay.append(stage, progress, bar);

  /** The slide as a whole is scaled to the window; text that is too long is made smaller. */
  const fit = () => {
    const scale = Math.min(stage.clientWidth / WIDTH, stage.clientHeight / HEIGHT);
    slide.style.transform = `scale(${scale > 0 ? scale : 1})`;
    content.style.zoom = '1';
    const room = slide.clientHeight - 2 * parseFloat(getComputedStyle(slide).paddingTop || '0');
    const height = content.scrollHeight;
    if (height > room && room > 0) content.style.zoom = String(Math.max(0.3, room / height));
  };
  const resize = new ResizeObserver(fit);
  resize.observe(stage);

  const show = async () => {
    const mine = ++generation;
    const current = slides[index];
    counter.textContent = slides.length ? `${index + 1} / ${slides.length}` : '0 / 0';
    progress.style.width = slides.length ? `${((index + 1) / slides.length) * 100}%` : '0';
    rendered?.dispose();
    rendered = undefined;
    if (!current) {
      content.textContent = 'This note has nothing to show.';
      return fit();
    }
    const next = document.createElement('div');
    next.className = content.className;
    const disposable = await reader.render(next, current.text, { sourcePath: path });
    if (mine !== generation) return disposable.dispose();
    rendered = disposable;
    content.replaceChildren(...next.childNodes);
    fit();
    // Pictures and formulas get their size a moment later.
    for (const img of content.querySelectorAll('img'))
      if (!img.complete) img.addEventListener('load', fit, { once: true });
    setTimeout(() => mine === generation && fit(), 150);
  };
  const go = (to: number) => {
    const next = Math.min(Math.max(0, to), Math.max(0, slides.length - 1));
    if (next === index) return;
    index = next;
    void show();
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void overlay.requestFullscreen?.().catch(() => undefined);
  };
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    generation++;
    if (document.fullscreenElement === overlay) void document.exitFullscreen();
    rendered?.dispose();
    resize.disconnect();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    previous?.focus?.();
    opts.onClose?.();
  };

  const onKey = (e: KeyboardEvent) => {
    // Something over the slides (an enlarged picture) has the keys.
    if (document.querySelector('.pm-lightbox')) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'];
    const back = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'];
    if (next.includes(e.key)) go(index + 1);
    else if (back.includes(e.key)) go(index - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(slides.length - 1);
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);

  // A click on the slide goes on (in its left quarter: back); what can be clicked on a slide
  // (a link, a picture, a video, a frame) keeps its own click.
  stage.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (
      target.closest('a, button, input, img, video, audio, iframe, summary, .pm-frame, .pm-video')
    )
      return;
    if (!document.getSelection()?.isCollapsed) return;
    const box = stage.getBoundingClientRect();
    go(e.clientX < box.left + box.width / 4 ? index - 1 : index + 1);
  });
  // A swipe on a touch screen.
  let touch: { x: number; y: number } | undefined;
  stage.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      touch = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : undefined;
    },
    { passive: true },
  );
  stage.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    if (!touch || !t) return;
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = undefined;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? index + 1 : index - 1);
  });
  // The controls show while the pointer moves, and go again.
  let idle: ReturnType<typeof setTimeout> | undefined;
  overlay.addEventListener('pointermove', () => {
    overlay.classList.add('is-active');
    clearTimeout(idle);
    idle = setTimeout(() => overlay.classList.remove('is-active'), 2200);
  });

  document.body.append(overlay);
  overlay.focus();
  void show();

  return {
    update(note) {
      if (closed) return;
      const at = slides[index]?.from ?? 0;
      const before = slides[index]?.text;
      slides = splitSlides(note);
      // The slide that was shown, where it is now: by its number, unless slides were added
      // or removed before it.
      index = Math.min(index, Math.max(0, slides.length - 1));
      if (slides[index]?.text !== before) {
        const moved = slides.findIndex((s) => s.text === before);
        if (moved >= 0) index = moved;
        else index = Math.min(slideAt(slides, at), Math.max(0, slides.length - 1));
      }
      void show();
    },
    close,
  };
}
