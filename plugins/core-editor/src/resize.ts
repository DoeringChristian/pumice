import type { EditorView } from '@codemirror/view';
import { createIcon } from '@pumice/ui';

/**
 * A drag handle in the bottom-right corner of an embedded picture, video or frame. Dragging
 * changes the size on screen; letting go writes it into the note (`![[x.png|300]]`).
 */

export interface Size {
  width: number;
  height?: number;
}

/** The text of a line with the size of the embed at `offset` set; null if there is none. */
export function embedSizeEdit(
  line: string,
  offset: number,
  size: Size,
  setSize: (inner: string, size: Size) => string,
): { from: number; to: number; insert: string } | null {
  let best: RegExpExecArray | undefined;
  for (const m of line.matchAll(/!\[\[([^\]\n]*)\]\]/g)) {
    // The widget sits at the embed's start; with several on a line, take the nearest before it.
    if (m.index <= offset && (!best || m.index > best.index)) best = m;
    if (!best) best = m;
  }
  if (!best) return null;
  const from = best.index + 3;
  const to = from + best[1]!.length;
  const insert = setSize(best[1]!, size);
  return insert === best[1] ? null : { from, to, insert };
}

/**
 * The embed at `offset` of a line, to take it out of the note: the range to delete (with one
 * of the spaces around it) and what it embeds.
 */
export function embedAt(
  line: string,
  offset: number,
): { from: number; to: number; target: string } | null {
  let best: RegExpExecArray | undefined;
  for (const m of line.matchAll(/!\[\[([^\]\n]*)\]\]/g)) {
    if (m.index <= offset && (!best || m.index > best.index)) best = m;
    if (!best) best = m;
  }
  if (!best) return null;
  let from = best.index;
  let to = from + best[0].length;
  if (line[to] === ' ') to++;
  else if (from > 0 && line[from - 1] === ' ') from--;
  return { from, to, target: best[1]!.split(/\\?\||#/)[0]!.trim() };
}

/** A fenced block (with its fences) with `width` and `height` set among its YAML lines. */
export function blockSizeEdit(source: string, size: Size): string {
  const lines = source.split('\n');
  const close = lines.length - 1 - (lines[lines.length - 1] === '' ? 1 : 0);
  if (lines.length < 2 || !/^\s*(`{3,}|~{3,})/.test(lines[close] ?? '')) return source;
  const indent = /^\s*/.exec(lines[0]!)![0];
  const set = (key: string, value: number | undefined) => {
    if (value === undefined) return;
    const text = `${indent}${key}: ${Math.round(value)}`;
    const at = lines.findIndex(
      (l, i) => i > 0 && i < close && new RegExp(`^\\s*${key}\\s*:`).test(l),
    );
    if (at >= 0) lines[at] = text;
    else lines.splice(lines.length - 1 - (lines[lines.length - 1] === '' ? 1 : 0), 0, text);
  };
  set('width', size.width);
  set('height', size.height);
  return lines.join('\n');
}

const SNAPS: Array<[string, number]> = [
  ['1/4', 1 / 4],
  ['1/3', 1 / 3],
  ['1/2', 1 / 2],
  ['2/3', 2 / 3],
  ['3/4', 3 / 4],
  ['full', 1],
];

/** The fraction of the line a dragged width is close enough to, if any. */
export function snapWidth(
  width: number,
  full: number,
  within = 14,
): { name: string; width: number } | undefined {
  let best: { name: string; width: number; distance: number } | undefined;
  for (const [name, fraction] of SNAPS) {
    const distance = Math.abs(width - full * fraction);
    if (distance <= within && (!best || distance < best.distance))
      best = { name, width: full * fraction, distance };
  }
  return best && { name: best.name, width: best.width };
}

// Pictures, videos, frames, and drawings (which are embedded as an SVG).
const SELECTOR = 'img:not(.cm-widgetBuffer), video, .pm-frame, .pm-excalidraw-embed > svg';

/**
 * Adds the handle to `host` if it shows something that can be sized. Call again after the
 * content was rendered anew.
 */
export function attachResizeHandle(
  view: EditorView,
  host: HTMLElement,
  commit: (size: Size) => void,
): void {
  // A drag is under way (a frame reports its size while it is dragged): leave it alone.
  if (host.classList.contains('is-resizing')) return;
  host.querySelector(':scope > .cm-pm-resize')?.remove();
  const target = host.querySelector<HTMLElement>(SELECTOR);
  if (!target || view.state.readOnly) return;
  // Only the embed itself, not pictures inside an embedded note.
  if (target.closest('.pm-embed[data-embed-type="note"]')) return;
  const isFrame = target.classList.contains('pm-frame');
  // Looked up when needed: a frame that reloads gets a new page element.
  const frameOf = () => (isFrame ? target.querySelector<HTMLElement>('.pm-frame-view') : null);
  if (isFrame && !frameOf()) return;

  host.classList.add('cm-pm-resizable');
  const handle = document.createElement('span');
  handle.className = 'cm-pm-resize';
  handle.title = 'Drag to resize';
  handle.append(createIcon('grip', 12));
  const label = document.createElement('span');
  label.className = 'cm-pm-resize-label';

  let start: { x: number; y: number; width: number; height: number } | undefined;
  let size: Size | undefined;
  const place = () => {
    // The corner of what is sized, which may be narrower than the line.
    const box = target.getBoundingClientRect();
    const outer = host.getBoundingClientRect();
    const bottom = (frameOf() ?? target).getBoundingClientRect().bottom;
    handle.style.left = `${box.right - outer.left - 18}px`;
    handle.style.top = `${bottom - outer.top - 18}px`;
  };
  // The editor must not take these as clicks into the text.
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = (frameOf() ?? target).getBoundingClientRect();
    start = {
      x: e.clientX,
      y: e.clientY,
      // The width it has in the text: beside others on a line it is drawn a little narrower
      // (the space between them comes out of it), and a drag goes on from the written width.
      width:
        Number.parseFloat(host.style.getPropertyValue('--embed-w')) ||
        target.getBoundingClientRect().width,
      height: box.height,
    };
    handle.setPointerCapture(e.pointerId);
    host.classList.add('is-resizing');
    handle.append(label);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const max = (host.parentElement ?? host).getBoundingClientRect().width;
    const free = Math.max(40, Math.min(max, start.width + e.clientX - start.x));
    // Snaps to simple fractions of the line; hold Alt to size freely.
    const snap = e.altKey ? undefined : snapWidth(free, max);
    const width = Math.round(snap?.width ?? free);
    target.style.width = `${width}px`;
    target.style.maxWidth = '100%';
    // In a row the room it takes follows the drag, so it shows as it will be when let go.
    if (host.style.getPropertyValue('--embed-w')) host.style.setProperty('--embed-w', `${width}px`);
    const frame = frameOf();
    if (frame) {
      const height = Math.round(Math.max(40, Math.min(4000, start.height + e.clientY - start.y)));
      frame.style.height = `${height}px`;
      size = { width, height };
      label.textContent = `${snap ? `${snap.name} · ` : ''}${width} × ${height}`;
    } else {
      // Pictures and videos keep their proportions.
      target.style.height = 'auto';
      target.removeAttribute('height');
      size = { width };
      label.textContent = `${snap ? `${snap.name} · ` : ''}${width}`;
    }
    place();
    view.requestMeasure();
  });
  const end = (e: PointerEvent) => {
    if (!start) return;
    start = undefined;
    host.classList.remove('is-resizing');
    label.remove();
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    if (size && e.type === 'pointerup') commit(size);
    size = undefined;
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  host.append(handle);
  place();
  // Pictures get their size when they have loaded.
  if (target instanceof HTMLImageElement && !target.complete)
    target.addEventListener('load', place, { once: true });
  host.addEventListener('pointerenter', place);
  // The content changes its size on its own too (a frame takes the height of its page).
  const observer = new ResizeObserver(() => {
    if (handle.isConnected) place();
    else observer.disconnect();
  });
  observer.observe(target);
  const inner = frameOf();
  if (inner) observer.observe(inner);
}

/**
 * A "⋮" button in the top-right corner of an embedded picture, video or frame, for what can be
 * done with it (the same menu as a right-click). Call again after the content was rendered
 * anew.
 */
export function attachMenuButton(
  host: HTMLElement,
  open: (at: { x: number; y: number }) => void,
  /**
   * Shows the source behind what is rendered. A click on a picture or frame does something else
   * (enlarges it, is handled by the frame), so there is a "</>" button for getting at the text.
   */
  edit?: () => void,
  /** Starts a comment on what is shown, without going to its source first. */
  comment?: () => void,
): void {
  for (const old of host.querySelectorAll(':scope > .cm-pm-embed-menu')) old.remove();
  const target = host.querySelector<HTMLElement>(`${SELECTOR}, audio, iframe`);
  if (!target || target.closest('.pm-embed[data-embed-type="note"]')) return;
  host.classList.add('cm-pm-has-menu');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-pm-embed-menu';
  button.title = 'More';
  button.setAttribute('aria-label', 'More');
  button.append(createIcon('more-vertical', 14));
  let source: HTMLButtonElement | undefined;
  if (edit) {
    source = document.createElement('button');
    source.type = 'button';
    source.className = 'cm-pm-embed-menu cm-pm-embed-edit';
    source.title = 'Edit the source';
    source.setAttribute('aria-label', 'Edit the source');
    source.append(createIcon('code', 14));
    source.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    source.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      edit();
    });
    host.append(source);
  }
  let note: HTMLButtonElement | undefined;
  if (comment) {
    note = document.createElement('button');
    note.type = 'button';
    note.className = 'cm-pm-embed-menu cm-pm-embed-comment';
    note.title = 'Add a comment';
    note.setAttribute('aria-label', 'Add a comment');
    note.append(createIcon('message-square-plus', 14));
    note.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    note.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      comment();
    });
    host.append(note);
  }
  const place = () => {
    // The corner of what is shown, which may be narrower than the line.
    const box = target.getBoundingClientRect();
    const outer = host.getBoundingClientRect();
    const left = Math.max(0, box.right - outer.left - 26);
    const top = `${Math.max(0, box.top - outer.top + 4)}px`;
    button.style.left = `${left}px`;
    button.style.top = top;
    if (source) {
      source.style.left = `${Math.max(0, left - 26)}px`;
      source.style.top = top;
    }
    if (note) {
      note.style.left = `${Math.max(0, left - (source ? 52 : 26))}px`;
      note.style.top = top;
    }
  };
  // The editor must not take these as clicks into the text.
  button.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = button.getBoundingClientRect();
    open({ x: r.left, y: r.bottom + 4 });
  });
  host.append(button);
  place();
  host.addEventListener('pointerenter', place);
  const observer = new ResizeObserver(() => {
    if (button.isConnected) place();
    else observer.disconnect();
  });
  observer.observe(target);
}
