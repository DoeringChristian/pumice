import type { EditorView } from '@codemirror/view';
import { TEXT_WIDTH, embedPattern, embedSizeCss, type EmbedSize } from '@pumice/api';
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
  for (const m of line.matchAll(embedPattern())) {
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
  for (const m of line.matchAll(embedPattern())) {
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

/**
 * A fenced frame block (with its fences) with its `caption` line set: after `file`, or in
 * place of the one that is there. An empty caption removes the line.
 */
export function blockCaptionEdit(source: string, caption: string): string {
  const lines = source.split('\n');
  const close = lines.length - 1 - (lines[lines.length - 1] === '' ? 1 : 0);
  if (lines.length < 2 || !/^\s*(`{3,}|~{3,})/.test(lines[close] ?? '')) return source;
  const indent = /^\s*/.exec(lines[0]!)![0];
  const text = caption.replace(/\s+/g, ' ').trim();
  const at = lines.findIndex((l, i) => i > 0 && i < close && /^\s*caption\s*:/.test(l));
  // Quoted, so that a colon or a hash in the caption is not taken for YAML.
  const line = `${indent}caption: ${JSON.stringify(text)}`;
  if (at >= 0) {
    if (text) lines[at] = line;
    else lines.splice(at, 1);
  } else if (text) {
    const file = lines.findIndex((l, i) => i > 0 && i < close && /^\s*file\s*:/.test(l));
    lines.splice(file >= 0 ? file + 1 : close, 0, line);
  }
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

/**
 * The number written into the note for a width on screen: its share of the line, as pixels
 * of the app's usual text width (the whole line is `TEXT_WIDTH`, half of it half of that).
 */
const written = (width: number, line: number): number =>
  Math.max(1, Math.round((Math.min(width, line) / line) * TEXT_WIDTH));

/** The space between the embeds of a row (pixels; see the CSS). */
const ROW_GAP = 12;

/**
 * The widths at which a dragged picture of a row is as high as one of the others. `max`: the
 * width of the line; `aspect`: width by height; `others`: what else is on the line, each with
 * the share it has of what the dragged one leaves (they give way in those proportions).
 */
export function sameHeightWidths(
  max: number,
  aspect: number,
  others: Array<{ share: number; aspect?: number }>,
): number[] {
  const n = others.length + 1;
  // What a picture is narrower than the room it takes: its part of the gaps.
  const c = ROW_GAP - ROW_GAP / n;
  const total = others.reduce((sum, o) => sum + o.share, 0);
  if (!(aspect > 0) || !(total > 0)) return [];
  return others.flatMap((o) => {
    if (!o.aspect || !(o.aspect > 0)) return [];
    const k = o.share / total;
    // (w - c) / aspect = ((max - w) k - c) / o.aspect, for w.
    const w = (max * k * aspect + c * (o.aspect - aspect)) / (o.aspect + k * aspect);
    return w > 0 && w < max ? [w] : [];
  });
}

/** The least room one of several on a line keeps while another is dragged wider (pixels). */
const ROW_MIN = 60;

// Pictures, videos, frames, and drawings (which are embedded as an SVG).
const SELECTOR = 'img:not(.cm-widgetBuffer), video, .pm-frame, .pm-excalidraw-embed > svg';

/**
 * Gives what an embed shows the size its text says, in place (as a drag of its handle does).
 * False if there is nothing in `host` that could be sized: it has to be drawn anew then.
 */
export function applyEmbedSize(host: HTMLElement, size: EmbedSize): boolean {
  const target = host.querySelector<HTMLElement>(SELECTOR);
  if (!target || target.closest('.pm-embed[data-embed-type="note"]')) return false;
  const css = embedSizeCss(size);
  target.style.width = css.width ?? '';
  target.style.maxWidth = css.width ? '100%' : '';
  // The share of the text's width a plain number stands for: a drag goes on from it.
  if (size.w && !size.w.unit) host.dataset.share = String(size.w.value / TEXT_WIDTH);
  else delete host.dataset.share;
  const frame = target.classList.contains('pm-frame')
    ? target.querySelector<HTMLElement>('.pm-frame-view')
    : null;
  if (frame) {
    // A frame's height is its own (pixels, unless it has a unit), whatever its width.
    if (size.h) frame.style.height = `${size.h.value}${size.h.unit || 'px'}`;
  } else {
    // Pictures and videos keep their proportions unless a height is given; with a plain
    // width and height (`300x200`) these are the proportions.
    target.style.aspectRatio = css.aspectRatio ?? '';
    target.style.height = css.height ?? 'auto';
    target.removeAttribute('height');
    target.removeAttribute('width');
  }
  return true;
}

/**
 * Adds the handle to `host` if it shows something that can be sized. Call again after the
 * content was rendered anew.
 */
export function attachResizeHandle(
  view: EditorView,
  host: HTMLElement,
  /**
   * `row`: the widths of the others on its line, which made room (or took what was left):
   * in a row the widths add up to the whole line.
   */
  commit: (size: Size, row?: Array<{ host: HTMLElement; width: number }>) => void,
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

  let start:
    { x: number; y: number; width: number; height: number; aspect: number | undefined } | undefined;
  let size: Size | undefined;
  /** How the embed stood in its row before the drag. */
  let before: { sized: boolean; width: string } | undefined;
  /** The others on its line: what share of the line each has, and how it stood. */
  let row: Array<{
    host: HTMLElement;
    target: HTMLElement | null;
    share: number;
    aspect: number | undefined;
    width: number;
    sized: boolean;
    css: string;
    inner: string;
  }> = [];
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
        Number(host.dataset.share) * (host.parentElement ?? host).getBoundingClientRect().width ||
        target.getBoundingClientRect().width,
      height: box.height,
      aspect: box.height > 0 ? target.getBoundingClientRect().width / box.height : undefined,
    };
    before = {
      sized: host.classList.contains('is-sized'),
      width: host.style.getPropertyValue('--embed-w'),
    };
    // The others on the line give way as this one grows, and take the room it leaves.
    const mates = [
      ...(host.parentElement?.querySelectorAll<HTMLElement>(':scope > .cm-pm-embed') ?? []),
    ];
    row = mates
      .filter((m) => m !== host)
      .map((m) => {
        const t = m.querySelector<HTMLElement>(SELECTOR);
        return {
          host: m,
          target: t && !t.closest('.pm-embed[data-embed-type="note"]') ? t : null,
          share: Math.max(1, m.getBoundingClientRect().width),
          // (A frame has a height of its own: nothing to be as high as.)
          aspect:
            t && !t.classList.contains('pm-frame') && t.getBoundingClientRect().height > 0
              ? t.getBoundingClientRect().width / t.getBoundingClientRect().height
              : undefined,
          width: 0,
          sized: m.classList.contains('is-sized'),
          css: m.style.getPropertyValue('--embed-w'),
          inner: t?.style.width ?? '',
        };
      });
    handle.setPointerCapture(e.pointerId);
    host.classList.add('is-resizing');
    handle.append(label);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const max = (host.parentElement ?? host).getBoundingClientRect().width;
    // (Each of the others on the line keeps some room.)
    const free = Math.max(
      40,
      Math.min(max - row.length * ROW_MIN, start.width + e.clientX - start.x),
    );
    // Snaps to simple fractions of the line; hold Alt to size freely.
    let snap = e.altKey ? undefined : snapWidth(free, max);
    // In a row also to where it is as high as one of the others (the nearer snap holds).
    if (!e.altKey && row.length && !isFrame && start.aspect) {
      for (const w of sameHeightWidths(max, start.aspect, row)) {
        const limit = max - row.length * ROW_MIN;
        if (w > limit || Math.abs(w - free) > 14) continue;
        if (!snap || Math.abs(w - free) <= Math.abs(snap.width - free))
          snap = { name: 'same height', width: w };
      }
    }
    const width = Math.round(snap?.width ?? free);
    target.style.width = `${width}px`;
    target.style.maxWidth = '100%';
    // In a row the room it takes follows the drag, so it shows as it will be when let go.
    // (One that had no width shared the row evenly: it gets one with the first move.)
    host.style.setProperty('--embed-w', `${width}px`);
    host.classList.add('is-sized');
    if (row.length) {
      // What is left of the line is theirs, in the proportions they had.
      const left = TEXT_WIDTH - written(width, max);
      const total = row.reduce((sum, o) => sum + o.share, 0);
      let given = 0;
      row.forEach((o, i) => {
        o.width =
          i === row.length - 1 ? left - given : Math.max(1, Math.round((left * o.share) / total));
        given += o.width;
        const px = `${(o.width / TEXT_WIDTH) * max}px`;
        o.host.style.setProperty('--embed-w', px);
        o.host.classList.add('is-sized');
        if (o.target) {
          o.target.style.width = px;
          o.target.style.maxWidth = '100%';
        }
      });
    }
    const frame = frameOf();
    if (frame) {
      const height = Math.round(Math.max(40, Math.min(4000, start.height + e.clientY - start.y)));
      frame.style.height = `${height}px`;
      size = { width: written(width, max), height };
      label.textContent = `${snap ? `${snap.name} · ` : ''}${Math.round((width / max) * 100)}% × ${height}`;
    } else {
      // Pictures and videos keep their proportions.
      target.style.height = 'auto';
      target.removeAttribute('height');
      size = { width: written(width, max) };
      label.textContent = `${snap ? `${snap.name} · ` : ''}${Math.round((width / max) * 100)}%`;
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
    if (size && e.type === 'pointerup')
      commit(
        size,
        row.filter((o) => o.width > 0).map((o) => ({ host: o.host, width: o.width })),
      );
    else if (before) {
      for (const o of row) {
        o.host.classList.toggle('is-sized', o.sized);
        if (o.css) o.host.style.setProperty('--embed-w', o.css);
        else o.host.style.removeProperty('--embed-w');
        if (o.target) o.target.style.width = o.inner;
      }
      // Given up: as it was.
      host.classList.toggle('is-sized', before.sized);
      if (before.width) host.style.setProperty('--embed-w', before.width);
      else host.style.removeProperty('--embed-w');
    }
    before = undefined;
    row = [];
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
  opts: {
    /**
     * Shows the source behind what is rendered. A click on a picture or frame does something
     * else (enlarges it, is handled by the frame), so there is a "</>" button for the text.
     */
    edit?: () => void;
    /** Starts a comment on what is shown, without going to its source first. */
    comment?: () => void;
    /** The text in the note that shows this: a button copies it, for another note. */
    copy?: () => string;
    /**
     * Also when nothing in `host` is a picture, video or frame (a frame block that could not
     * be shown, a diagram): the buttons then stand in the corner of `host` itself. Such a
     * block shows its source only through the "</>" button, so it must always have one.
     */
    always?: boolean;
  } = {},
): void {
  for (const old of host.querySelectorAll(':scope > .cm-pm-embed-menu')) old.remove();
  const shown = host.querySelector<HTMLElement>(`${SELECTOR}, audio, iframe`);
  if (shown?.closest('.pm-embed[data-embed-type="note"]')) return;
  const target = shown ?? (opts.always ? host : null);
  if (!target) return;
  host.classList.add('cm-pm-has-menu');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-pm-embed-menu';
  button.title = 'More';
  button.setAttribute('aria-label', 'More');
  button.append(createIcon('more-vertical', 14));
  // From the corner to the left: more, copy, source, comment.
  const buttons = [button];
  const extra = (name: string, label: string, icon: string, run: (b: HTMLElement) => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `cm-pm-embed-menu cm-pm-embed-${name}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(createIcon(icon, 14));
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run(b);
    });
    host.append(b);
    buttons.push(b);
  };
  const { edit, comment, copy } = opts;
  if (copy)
    extra('copy', 'Copy as text for a note', 'copy', (b) => {
      void navigator.clipboard.writeText(copy()).then(() => {
        // Shows for a moment that it did.
        b.replaceChildren(createIcon('check', 14));
        setTimeout(() => b.replaceChildren(createIcon('copy', 14)), 1200);
      });
    });
  if (edit) extra('edit', 'Edit the source', 'code', edit);
  if (comment) extra('comment', 'Add a comment', 'message-square-plus', comment);
  const place = () => {
    // The corner of what is shown, which may be narrower than the line.
    const box = target.getBoundingClientRect();
    const outer = host.getBoundingClientRect();
    const right = Math.max(0, box.right - outer.left - 26);
    const top = `${Math.max(0, box.top - outer.top + 4)}px`;
    // Without a gap where a button is not shown (while reading, only copying is left).
    let slot = 0;
    for (const b of buttons) {
      if (getComputedStyle(b).display === 'none') continue;
      b.style.left = `${Math.max(0, right - 26 * slot++)}px`;
      b.style.top = top;
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
