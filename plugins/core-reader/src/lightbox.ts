import { createVideoControls } from '@pumice/ui';

/** The address of a picture in a note (once it is there; until then what holds its place). */
const addressOf = (img: HTMLImageElement) => img.dataset.full || img.src;

/**
 * The pictures of the note `img` is in, in order (those drawn: a long note in the editor draws
 * what is near the screen), and where `img` is among them.
 */
function picturesAround(img: HTMLImageElement): { pictures: HTMLImageElement[]; at: number } {
  let note: HTMLElement | null = img.closest('.pm-markdown-page');
  for (let el = img.parentElement; !note && el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll') note = el;
  }
  const pictures = [
    ...(note ?? document.body).querySelectorAll<HTMLImageElement>('img.pm-zoomable'),
  ];
  return { pictures, at: Math.max(0, pictures.indexOf(img)) };
}

/** Enlarges a picture of a note; the arrow keys (or a swipe) go to the note's others. */
export function showPicture(img: HTMLImageElement): void {
  showLightbox(addressOf(img), img.alt, undefined, picturesAround(img));
}

/**
 * A picture or a video enlarged over the whole window. A click, Escape or scrolling away
 * closes it; the wheel (with Ctrl/Cmd, or a pinch) zooms in on the pointer. A video has its
 * controls along the bottom and goes on from where the one in the note was; only its play
 * button plays it. With `around`, the left and right arrow keys, or a swipe, show the picture
 * before or after it, zoomed in on the same place.
 */
export function showLightbox(
  src: string,
  alt = '',
  from?: HTMLVideoElement,
  around?: { pictures: HTMLImageElement[]; at: number },
): void {
  document.querySelector('.pm-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'pm-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', alt || (from ? 'Video' : 'Picture'));
  overlay.tabIndex = -1;
  let img: HTMLImageElement | HTMLVideoElement;
  let controls: HTMLElement | undefined;
  if (from) {
    const video = document.createElement('video');
    video.src = src;
    video.playsInline = true;
    video.muted = from.muted;
    video.loop = from.loop;
    video.volume = from.volume;
    const wasPlaying = !from.paused && !from.ended;
    from.pause();
    video.addEventListener(
      'loadedmetadata',
      () => {
        video.currentTime = from.currentTime;
        if (wasPlaying) void video.play().catch(() => undefined);
      },
      { once: true },
    );
    controls = createVideoControls(video);
    controls.classList.add('pm-lightbox-controls');
    img = video;
  } else {
    const picture = document.createElement('img');
    picture.src = src;
    picture.alt = alt;
    picture.draggable = false;
    img = picture;
  }
  overlay.append(img);
  if (controls) overlay.append(controls);
  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    overlay.classList.toggle('is-zoomed', scale > 1);
  };
  const previous = document.activeElement as HTMLElement | null;
  let at = around?.at ?? 0;
  /** The picture before (-1) or after (1), at the same zoom and place. */
  const step = (by: -1 | 1): boolean => {
    const next = around?.pictures[at + by];
    if (!next || !(img instanceof HTMLImageElement)) return false;
    at += by;
    img.src = addressOf(next);
    img.alt = next.alt;
    overlay.setAttribute('aria-label', next.alt || 'Picture');
    // Zoomed in and moved as the one before: the same place in each, to compare them.
    return true;
  };
  const close = () => {
    // The video in the note is where this one got to.
    if (from && img instanceof HTMLVideoElement) {
      img.pause();
      if (Number.isFinite(img.currentTime)) from.currentTime = img.currentTime;
      from.muted = img.muted;
    }
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    previous?.focus?.();
    // Back in the note at the picture looked at last.
    if (around && at !== around.at)
      around.pictures[at]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === ' ' && img instanceof HTMLVideoElement && !controls?.contains(e.target as Node)) {
      e.preventDefault();
      e.stopPropagation();
      if (img.paused || img.ended) void img.play().catch(() => undefined);
      else img.pause();
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && around) {
      e.preventDefault();
      e.stopPropagation();
      step(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onControls = (e: Event) => !!controls?.contains(e.target as Node);
  overlay.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Zoom around the pointer.
      const next = Math.min(12, Math.max(1, scale * Math.exp(-e.deltaY / 250)));
      const rect = img.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      x -= cx * (next / scale - 1);
      y -= cy * (next / scale - 1);
      scale = next;
      if (scale === 1) x = y = 0;
      apply();
    },
    { passive: false },
  );
  // Drag to move around when zoomed in; a click without a drag closes.
  let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | undefined;
  overlay.addEventListener('pointerdown', (e) => {
    if (onControls(e)) return;
    drag = { x: e.clientX, y: e.clientY, ox: x, oy: y, moved: false };
    overlay.setPointerCapture(e.pointerId);
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
    if (scale > 1 && drag.moved) {
      x = drag.ox + e.clientX - drag.x;
      y = drag.oy + e.clientY - drag.y;
      apply();
    }
  });
  overlay.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const moved = drag.moved;
    // Not zoomed in: a swipe to the side goes to the picture before or after.
    const dx = e.clientX - drag.x;
    const swiped =
      scale === 1 && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(e.clientY - drag.y);
    drag = undefined;
    if (swiped) step(dx > 0 ? -1 : 1);
    if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
    if (!moved) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  overlay.focus();
}
