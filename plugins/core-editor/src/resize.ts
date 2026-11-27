import type { EditorView } from '@codemirror/view';
import { TEXT_WIDTH, embedShare, mediaAt, sizeEmbed, type EmbedSize } from '@pumice/api';
import { createIcon } from '@pumice/ui';

/**
 * A drag handle in the bottom-right corner of an embedded picture, video or frame. Dragging
 * changes the size on screen; letting go writes it into the note (`![[x.png]]{width=50%}`).
 */

export interface Size {
  width: number;
  height?: number;
}

/**
 * The embed at `offset` of a line, to take it out of the note: the range to delete (with one
 * of the spaces around it) and what it embeds.
 */
export function embedAt(
  line: string,
  offset: number,
): { from: number; to: number; target: string } | null {
  const best = mediaAt(line, offset);
  if (!best) return null;
  // With the attributes behind it (`{width=50%}`), which are part of it.
  let { from, to } = best;
  if (line[to] === ' ') to++;
  else if (from > 0 && line[from - 1] === ' ') from--;
  return { from, to, target: best.target };
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

/**
 * How wide the text is: what the widths in the note are shares of (see `--pm-text-w`). A drag
 * works with it, so what is shown while dragging is what is drawn after.
 */
const textWidthOf = (host: HTMLElement): number =>
  parseFloat(getComputedStyle(host).getPropertyValue('--pm-text-w')) ||
  lineOf(host).getBoundingClientRect().width;

/** The embeds on the same line as `host` (itself included), in order. */
const rowOf = (host: HTMLElement): HTMLElement[] => [
  ...lineOf(host).querySelectorAll<HTMLElement>(
    ':scope > .cm-pm-embed, :scope > .cm-pm-figure > .cm-pm-embed',
  ),
];

/**
 * The share of the text's width an embed has in the note (0.3 for `30%`), from the width its box
 * is given (`--embed-w`, on it or on its figure). Undefined if it has none, or one in pixels.
 */
function shareOf(host: HTMLElement): number | undefined {
  for (const el of [host, host.closest<HTMLElement>('.cm-pm-figure')]) {
    const w = el?.style.getPropertyValue('--embed-w') ?? '';
    const m = /var\(--pm-text-w[^)]*\)\s*\*\s*([\d.]+)\)/.exec(w);
    if (m) return Number(m[1]);
  }
  const share = Number(host.dataset.share);
  return share > 0 && host.classList.contains('is-sized') ? share : undefined;
}

/**
 * The width an embed of a row has in the text (in `TEXT_WIDTH` units): what is written, or, for
 * one without a width, the room it is given (its part of the gaps counted to it).
 */
function writtenWidth(host: HTMLElement, line: number, count: number): number {
  const share = shareOf(host);
  if (share !== undefined) return share * TEXT_WIDTH;
  const room = host.getBoundingClientRect().width + (ROW_GAP * (count - 1)) / count;
  return (room / line) * TEXT_WIDTH;
}

/**
 * How wide the embeds of a row are drawn, given the widths they have (pixels, the space to the
 * next counted to each): as the style sheet lays a row out, so a drag shows what will be.
 * Each starts from its width less the gap; what the line has left over is shared out evenly,
 * none growing beyond its width; what is missing is taken from each in proportion.
 */
export function rowLayout(widths: number[], line: number, gap = ROW_GAP): number[] {
  const out = widths.map((w) => Math.max(0, w - gap));
  let free = line - gap * (widths.length - 1) - out.reduce((t, w) => t + w, 0);
  if (free < 0) {
    const total = out.reduce((t, w) => t + w, 0) || 1;
    return out.map((w) => Math.max(0, w + (free * w) / total));
  }
  let growing = out.map((w, i) => w < widths[i]!);
  while (free > 0.01 && growing.some(Boolean)) {
    const each = free / growing.filter(Boolean).length;
    free = 0;
    out.forEach((w, i) => {
      if (!growing[i]) return;
      const room = widths[i]! - w;
      const take = Math.min(room, each);
      out[i] = w + take;
      free += each - take;
      if (take >= room) growing[i] = false;
    });
    growing = growing.map((g, i) => g && out[i]! < widths[i]!);
  }
  return out;
}

/** The width of what the embeds of a line are laid out in (without its padding). */
function lineRoom(host: HTMLElement): number {
  const line = lineOf(host);
  const style = getComputedStyle(line);
  return (
    line.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
  );
}

/**
 * While a row is dragged, what each of its embeds is drawn as: from `widths` (pixels), laid out
 * as at rest. Without widths: as they are drawn now (when a drag begins).
 */
function previewRow(hosts: HTMLElement[], widths?: number[]): void {
  const drawn = widths
    ? rowLayout(widths, lineRoom(hosts[0]!))
    : hosts.map((h) => (h.closest('.cm-pm-figure') ?? h).getBoundingClientRect().width);
  hosts.forEach((h, i) => h.style.setProperty('--drag-w', `${drawn[i]}px`));
}

/** After a drag, the row is laid out by the style sheet again. */
const endPreview = (hosts: HTMLElement[]) =>
  hosts.forEach((h) => h.style.removeProperty('--drag-w'));

/** Where a handle stands: this far in from the corner of what is shown (pixels). */
const CORNER = 18;

/** The least room one of several on a line keeps while another is dragged wider (pixels). */
const ROW_MIN = 60;

// Pictures, videos, frames, and drawings (which are embedded as an SVG).
const SELECTOR = '.pm-embed-media, .pm-frame';

/** The line an embed or a block stands on. */
const lineOf = (host: HTMLElement) =>
  host.closest<HTMLElement>('.cm-line') ?? host.parentElement ?? host;

/**
 * Gives what an embed shows the size its text says, in place (as a drag of its handle does).
 * False if there is nothing in `host` that could be sized: it has to be drawn anew then.
 */
export function applyEmbedSize(host: HTMLElement, size: EmbedSize): boolean {
  const target = host.querySelector<HTMLElement>(SELECTOR);
  if (!target || target.closest('.pm-embed[data-embed-type="note"]')) return false;
  sizeEmbed(host, size);
  // The share of the text's width a plain number stands for: a drag goes on from it.
  const share = embedShare(size.w);
  if (share !== undefined) host.dataset.share = String(share / TEXT_WIDTH);
  else delete host.dataset.share;
  const frame = target.classList.contains('pm-frame')
    ? target.querySelector<HTMLElement>('.pm-frame-view')
    : null;
  if (frame) {
    // A frame's height is its own (pixels, unless it has a unit), whatever its width.
    if (size.h) frame.style.height = `${size.h.value}${size.h.unit || 'px'}`;
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
  host.querySelector(':scope > .cm-pm-resize:not(.cm-pm-row-resize)')?.remove();
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
  // A picture or video keeps its proportions: its width is all there is to drag, at its right
  // edge (in a row, the border to the next one). A frame has a height too: its corner.
  // A button in its bottom-right corner.
  handle.className = 'cm-pm-resize';
  handle.append(createIcon('grip', 12));
  handle.title = isFrame ? 'Drag to resize' : 'Drag to make it wider or narrower';
  const label = document.createElement('span');
  label.className = 'cm-pm-resize-label';

  /** The box has the width; a block that is not an embed (a frame) has it itself. */
  const setWidth = (box: HTMLElement, shown: HTMLElement | null, width: string) => {
    if (box.classList.contains('pm-embed')) {
      // (The figure around it, with its caption, is as wide as it is.)
      box.style.setProperty('--embed-w', width);
      box.classList.add('is-sized');
    } else if (shown) {
      shown.style.width = width;
      shown.style.maxWidth = '100%';
    }
  };

  let start:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
        aspect: number | undefined;
        /** How wide the row is in the text (`TEXT_WIDTH` units): a drag keeps it. */
        total: number;
      }
    | undefined;
  let size: Size | undefined;
  /** How the embed stood in its row before the drag. */
  let before: { sized: boolean; width: string } | undefined;
  /** The others on its line: what share of the line each has, and how it stood. */
  /** The others of its row, which keep their widths (`TEXT_WIDTH` units). */
  let rest: Array<{ host: HTMLElement; width: number }> = [];
  let row: Array<{
    host: HTMLElement;
    target: HTMLElement | null;
    share: number;
    aspect: number | undefined;
    width: number;
    sized: boolean;
    css: string;
  }> = [];
  const place = () => {
    const box = target.getBoundingClientRect();
    const outer = host.getBoundingClientRect();
    // The last of a row has the row's handle there instead (see `attachRowHandle`).
    const mates = rowOf(host);
    handle.hidden = !isFrame && mates.length > 1 && mates[mates.length - 1] === host;
    // The corner of what is sized, which may be narrower than the line.
    const bottom = (frameOf() ?? target).getBoundingClientRect().bottom;
    handle.style.left = `${box.right - outer.left - CORNER}px`;
    handle.style.top = `${bottom - outer.top - CORNER}px`;
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
      width: (shareOf(host) ?? 0) * textWidthOf(host) || target.getBoundingClientRect().width,
      height: box.height,
      aspect: box.height > 0 ? target.getBoundingClientRect().width / box.height : undefined,
      total: TEXT_WIDTH,
    };
    before = {
      sized: host.classList.contains('is-sized'),
      width: host.style.getPropertyValue('--embed-w'),
    };
    // In a row it is the border to the next one: that one gives way as this one grows, and
    // takes the room it leaves; the two stay as wide together, the others as they are.
    const mates = rowOf(host);
    const next = mates[mates.indexOf(host) + 1];
    const line = textWidthOf(host);
    rest = mates
      .filter((m) => m !== host && m !== next)
      .map((m) => ({ host: m, width: writtenWidth(m, line, mates.length) }));
    if (next)
      start.total = Math.round(
        writtenWidth(host, line, mates.length) + writtenWidth(next, line, mates.length),
      );
    row = (next ? [next] : []).map((m) => {
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
      };
    });
    handle.setPointerCapture(e.pointerId);
    // (Before the row is laid out for the drag: it stays as it is drawn.)
    if (mates.length > 1) previewRow(mates);
    host.classList.add('is-resizing');
    handle.append(label);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    // (A press that moves by a pixel or two is not a drag yet.)
    if (!size && Math.abs(e.clientX - start.x) < 3 && Math.abs(e.clientY - start.y) < 3) return;
    const line = textWidthOf(host);
    // In a row, the room the row has: the others give way within it, it stays as wide.
    const max = row.length ? (start.total / TEXT_WIDTH) * line : line;
    // (Each of the others on the line keeps some room.)
    const free = Math.max(
      40,
      Math.min(max - row.length * ROW_MIN, start.width + e.clientX - start.x),
    );
    // Snaps to simple fractions of the line; hold Alt to size freely.
    let snap = e.altKey ? undefined : snapWidth(free, line);
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
    // In a row the room it takes follows the drag, so it shows as it will be when let go.
    // (One that had no width shared the row evenly: it gets one with the first move.)
    setWidth(host, target, `${width}px`);
    if (row.length) {
      // What is left of the line is theirs, in the proportions they had.
      const left = start.total - written(width, line);
      const total = row.reduce((sum, o) => sum + o.share, 0);
      let given = 0;
      row.forEach((o, i) => {
        o.width =
          i === row.length - 1 ? left - given : Math.max(1, Math.round((left * o.share) / total));
        given += o.width;
        setWidth(o.host, o.target, `${(o.width / TEXT_WIDTH) * line}px`);
      });
      const hosts = rowOf(host);
      previewRow(
        hosts,
        hosts.map((h) => {
          if (h === host) return width;
          const w = row.find((o) => o.host === h)?.width ?? rest.find((o) => o.host === h)?.width;
          return ((w ?? 0) / TEXT_WIDTH) * line;
        }),
      );
    }
    const frame = frameOf();
    if (frame) {
      const height = Math.round(Math.max(40, Math.min(4000, start.height + e.clientY - start.y)));
      frame.style.height = `${height}px`;
      size = { width: written(width, line), height };
      label.textContent = `${snap ? `${snap.name} · ` : ''}${Math.round((width / line) * 100)}% × ${height}`;
    } else {
      // Pictures and videos keep their proportions.
      size = { width: written(width, line) };
      label.textContent = `${snap ? `${snap.name} · ` : ''}${Math.round((width / line) * 100)}%`;
    }
    place();
    view.requestMeasure();
  });
  const end = (e: PointerEvent) => {
    if (!start) return;
    start = undefined;
    host.classList.remove('is-resizing');
    endPreview(rowOf(host));
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
  if (!isFrame) attachRowHandle(host, setWidth, commit);
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
 * The handle of a whole row, beside its last embed: it makes the row wider or narrower, every
 * embed of it in proportion (each one's own handle moves the border between it and the others).
 */
function attachRowHandle(
  host: HTMLElement,
  setWidth: (box: HTMLElement, shown: HTMLElement | null, width: string) => void,
  commit: (size: Size, row?: Array<{ host: HTMLElement; width: number }>) => void,
): void {
  host.querySelector(':scope > .cm-pm-row-resize')?.remove();
  const grip = document.createElement('span');
  grip.className = 'cm-pm-resize cm-pm-row-resize';
  grip.append(createIcon('grip', 12));
  grip.title = 'Drag to make the row wider or narrower';
  const label = document.createElement('span');
  label.className = 'cm-pm-resize-label';
  /** Only beside the last of a row of several. */
  const show = () => {
    const mates = rowOf(host);
    grip.hidden = mates.length < 2 || mates[mates.length - 1] !== host;
    if (grip.hidden) return;
    // In the corner of what is shown, where its own handle would be.
    const box = (host.querySelector<HTMLElement>(SELECTOR) ?? host).getBoundingClientRect();
    const outer = host.getBoundingClientRect();
    grip.style.left = `${box.right - outer.left - CORNER}px`;
    grip.style.top = `${box.bottom - outer.top - CORNER}px`;
  };
  let drag:
    | {
        x: number;
        moved?: boolean;
        line: number;
        total: number;
        items: Array<{
          host: HTMLElement;
          target: HTMLElement | null;
          width: number;
          now: number;
          sized: boolean;
          css: string;
        }>;
      }
    | undefined;
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const mates = rowOf(host);
    const line = textWidthOf(host);
    const items = mates.map((m) => {
      const width = writtenWidth(m, line, mates.length);
      return {
        host: m,
        target: m.querySelector<HTMLElement>(SELECTOR),
        width,
        now: width,
        sized: m.classList.contains('is-sized'),
        css: m.style.getPropertyValue('--embed-w'),
      };
    });
    drag = { x: e.clientX, line, total: items.reduce((t, i) => t + i.width, 0), items };
    grip.setPointerCapture(e.pointerId);
    previewRow(mates);
    for (const m of mates) m.classList.add('is-resizing');
    grip.append(label);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) < 3) return;
    drag.moved = true;
    const { line, total, items } = drag;
    const from = (total / TEXT_WIDTH) * line;
    // Not wider than the text, and each keeps some room.
    const least = (ROW_MIN * items.length * TEXT_WIDTH) / line;
    const wanted = (total * Math.max(1, from + e.clientX - drag.x)) / from;
    const next = Math.max(Math.min(least, total), Math.min(TEXT_WIDTH, wanted));
    let given = 0;
    items.forEach((item, i) => {
      item.now =
        i === items.length - 1
          ? Math.round(next) - given
          : Math.max(1, Math.round((item.width * next) / total));
      given += item.now;
      setWidth(item.host, item.target, `${(item.now / TEXT_WIDTH) * line}px`);
    });
    previewRow(
      items.map((i) => i.host),
      items.map((i) => (i.now / TEXT_WIDTH) * line),
    );
    label.textContent = `row ${Math.round((total / TEXT_WIDTH) * 100)}% → ${Math.round((next / TEXT_WIDTH) * 100)}%`;
    show();
  });
  const end = (e: PointerEvent) => {
    if (!drag) return;
    const { items } = drag;
    drag = undefined;
    label.remove();
    for (const item of items) item.host.classList.remove('is-resizing');
    endPreview(items.map((i) => i.host));
    if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    const self = items.find((i) => i.host === host);
    if (e.type === 'pointerup' && self && items.some((i) => Math.round(i.width) !== i.now))
      commit(
        { width: self.now },
        items.filter((i) => i.host !== host).map((i) => ({ host: i.host, width: i.now })),
      );
    else
      for (const item of items) {
        // Given up: as it was.
        item.host.classList.toggle('is-sized', item.sized);
        if (item.css) item.host.style.setProperty('--embed-w', item.css);
        else item.host.style.removeProperty('--embed-w');
      }
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  host.addEventListener('pointerenter', show);
  host.append(grip);
  show();
  // It moves with the corner, also when another of the row is dragged.
  const shown = host.querySelector<HTMLElement>(SELECTOR);
  if (shown) {
    const observer = new ResizeObserver(() => {
      if (grip.isConnected) show();
      else observer.disconnect();
    });
    observer.observe(shown);
  }
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
    /** A picture: the button copies the picture itself, with that text beside it. */
    copyPicture?: () => Promise<void>;
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
  const { edit, comment, copy, copyPicture } = opts;
  if (copy)
    extra(
      'copy',
      copyPicture ? 'Copy the picture (a note pastes it as its text)' : 'Copy as text for a note',
      'copy',
      (b) => {
        void (copyPicture ? copyPicture() : navigator.clipboard.writeText(copy())).then(
          () => {
            // Shows for a moment that it did.
            b.replaceChildren(createIcon('check', 14));
            setTimeout(() => b.replaceChildren(createIcon('copy', 14)), 1200);
          },
          // (The picture could not be read or drawn: its text, at least.)
          () => void navigator.clipboard.writeText(copy()).catch(() => undefined),
        );
      },
    );
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
