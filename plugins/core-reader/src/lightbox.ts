/**
 * A picture enlarged over the whole window. A click, Escape or scrolling away closes it; the
 * wheel (with Ctrl/Cmd, or a pinch) zooms in on the pointer.
 */
export function showLightbox(src: string, alt = ''): void {
  document.querySelector('.pm-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'pm-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', alt || 'Picture');
  overlay.tabIndex = -1;
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  img.draggable = false;
  overlay.append(img);

  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    overlay.classList.toggle('is-zoomed', scale > 1);
  };
  const previous = document.activeElement as HTMLElement | null;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    previous?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
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
  overlay.addEventListener('pointerup', () => {
    const moved = drag?.moved;
    drag = undefined;
    if (!moved) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  overlay.focus();
}
