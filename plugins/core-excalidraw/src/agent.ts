/**
 * Drawings for agents: a description of what is in one (ids, kinds, places, sizes, text, what
 * each arrow joins), and changes to it given as a few plain operations. Pure functions: the
 * elements are made here, as Excalidraw reads them, so this also runs where the drawing
 * library does not.
 */
import type { DrawingElement, Scene } from './format';

/** One change to a drawing, as an agent gives it. Only `op` is always there. */
export interface DrawingOp {
  op: 'add' | 'update' | 'delete' | 'align' | 'distribute' | 'group' | 'ungroup' | 'order';
  id?: string;
  /** The elements an `align`, `distribute`, `group`, `ungroup` or `order` is about. */
  ids?: string[];
  /** `align`: the side or middle the elements are brought to. */
  align?: string;
  /** `distribute`: along which the elements get equal gaps. */
  direction?: string;
  /** `distribute`: the gap to give them; left out, they are spread between the outer two. */
  gap?: number;
  /** `order`: in front of everything, or behind it. */
  position?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** The text of a text element, or the label of a shape or an arrow. */
  text?: string;
  /** For arrows: the ids of the elements it starts and ends at. */
  from?: string | null;
  to?: string | null;
  /** For arrows and lines that are not between two elements: the points they go through. */
  points?: Array<[number, number]>;
  stroke?: string;
  fill?: string;
  strokeStyle?: string;
  strokeWidth?: number;
  fontSize?: number;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  opacity?: number;
  /**
   * The text holds LaTeX between `$…$` (the drawing's math mode). Left out, a text with a
   * `$…$` in it is taken for one.
   */
  math?: boolean;
  /**
   * For an arrow between two elements: 'elbow' (the default) goes at right angles from the
   * side of the one to the side of the other, 'straight' in one line between them.
   */
  route?: string;
}

/** How the elements joined by arrows are laid out as a whole: a flow downwards or to the right. */
export type Arrange = 'down' | 'right';

/** How large a text is when drawn (one or more lines). */
export type MeasureText = (text: string, fontSize: number) => { width: number; height: number };

const LINE_HEIGHT = 1.25;
const PADDING = 12;
/** How far an arrow stays from the outline of what it joins. */
const GAP = 6;
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);
const LINEAR = new Set(['arrow', 'line']);
const DEFAULT_STROKE = '#1e1e1e';

/** A guess where nothing can measure: the letters of the drawing font are about half as wide as tall. */
export const estimateText: MeasureText = (text, fontSize) => {
  const lines = text.split('\n');
  return {
    width: Math.ceil(Math.max(1, ...lines.map((l) => l.length)) * fontSize * 0.55),
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
  };
};

/** Whether a text is drawn in math mode: said so, or with a `$…$` formula in it. */
const isMath = (text: string, said: boolean | undefined) =>
  said ?? /(^|[^\\])\$[^$\n]+\$/.test(text);
/** About what a text with formulas shows, to guess its size from: commands and braces take no room. */
const shownMath = (text: string) => text.replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}$^_]/g, '');

const round = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && isFinite(v) ? v : fallback);
const random = () => Math.floor(Math.random() * 2 ** 31);

function newId(taken: Set<string>): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    let id = '';
    for (let i = 0; i < 8; i++) id += letters[Math.floor(Math.random() * letters.length)];
    if (!taken.has(id)) return id;
  }
}

type Bound = { id: string; type: string };
const boundOf = (e: DrawingElement): Bound[] =>
  Array.isArray(e.boundElements) ? (e.boundElements as Bound[]) : [];
const pointsOf = (e: DrawingElement): Array<[number, number]> =>
  Array.isArray(e.points) ? (e.points as Array<[number, number]>) : [];
const bindingOf = (e: DrawingElement, end: 'startBinding' | 'endBinding'): string | undefined =>
  (e[end] as { elementId?: string } | null | undefined)?.elementId;

// ---- describing ------------------------------------------------------------------------------

/** What is in a drawing, a line for each element, and what looks wrong in its layout. */
export function describeDrawing(scene: Scene, embedded: Record<string, string> = {}): string {
  const live = scene.elements.filter((e) => !e.isDeleted);
  if (!live.length) return 'The drawing is empty.';
  const byId = new Map(live.map((e) => [e.id, e]));
  const labelOf = (e: DrawingElement): DrawingElement | undefined =>
    boundOf(e)
      .filter((b) => b.type === 'text')
      .map((b) => byId.get(b.id))
      .find((t) => t);
  const textOf = (e: DrawingElement) => JSON.stringify(String(e.originalText ?? e.text ?? ''));
  const style = (e: DrawingElement): string => {
    const parts: string[] = [];
    if (e.strokeColor && e.strokeColor !== DEFAULT_STROKE) parts.push(`stroke ${e.strokeColor}`);
    if (e.backgroundColor && e.backgroundColor !== 'transparent')
      parts.push(`fill ${e.backgroundColor}`);
    if (e.strokeStyle && e.strokeStyle !== 'solid') parts.push(String(e.strokeStyle));
    if (typeof e.opacity === 'number' && e.opacity !== 100) parts.push(`opacity ${e.opacity}`);
    if (e.frameId) parts.push(`in frame ${e.frameId}`);
    return parts.length ? `, ${parts.join(', ')}` : '';
  };
  const lines: string[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of live) {
    const label = labelOf(e);
    // A label is told with what it labels.
    if (e.type === 'text' && e.containerId && byId.has(String(e.containerId))) continue;
    minX = Math.min(minX, e.x as number);
    minY = Math.min(minY, e.y as number);
    maxX = Math.max(maxX, (e.x as number) + num(e.width));
    maxY = Math.max(maxY, (e.y as number) + num(e.height));
    const at = `at (${round(num(e.x))}, ${round(num(e.y))})`;
    const size = `size ${round(num(e.width))}×${round(num(e.height))}`;
    let line = `[${e.id}] ${e.type} `;
    if (LINEAR.has(e.type)) {
      const from = bindingOf(e, 'startBinding');
      const to = bindingOf(e, 'endBinding');
      if (from || to) line += `from ${from ?? '(nothing)'} to ${to ?? '(nothing)'}, `;
      const points = pointsOf(e).map(
        ([px, py]) => `(${round(num(e.x) + px)}, ${round(num(e.y) + py)})`,
      );
      line += `through ${points.join(' ')}`;
      if (e.type === 'arrow') {
        const heads = `${e.startArrowhead ?? 'none'}/${e.endArrowhead ?? 'none'}`;
        if (heads !== 'none/arrow') line += `, heads ${heads}`;
      }
    } else if (e.type === 'text') {
      line += `${at} ${size}, text ${textOf(e)}${e.subtype === 'math' ? ' (math)' : ''}, font size ${num(e.fontSize, 20)}`;
    } else if (e.type === 'image') {
      const file = embedded[String(e.fileId ?? '')];
      line += `${at} ${size}${file ? `, file ${file}` : ''}`;
    } else if (e.type === 'frame' || e.type === 'magicframe') {
      line += `${at} ${size}${e.name ? `, name ${JSON.stringify(e.name)}` : ''}`;
    } else line += `${at} ${size}`;
    if (label) line += `, label ${textOf(label)}${label.subtype === 'math' ? ' (math)' : ''}`;
    lines.push(line + style(e));
  }
  const notes = layoutNotes(live);
  return [
    `${lines.length} elements, within x ${round(minX)}…${round(maxX)}, y ${round(minY)}…${round(maxY)} (y grows downwards).`,
    ...lines,
    ...(notes.length ? ['', 'Layout notes:', ...notes.map((n) => `- ${n}`)] : []),
  ].join('\n');
}

type Box = { l: number; t: number; r: number; b: number };
const boxOf = (e: DrawingElement): Box => ({
  l: num(e.x),
  t: num(e.y),
  r: num(e.x) + num(e.width),
  b: num(e.y) + num(e.height),
});
const boxesMeet = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
type Point = [number, number];
/** Whether two segments cross (not merely touch at an end). */
function segmentsCross(p: Point, q: Point, r: Point, s: Point): boolean {
  const side = (a: Point, b: Point, c: Point) =>
    Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return side(p, q, r) * side(p, q, s) < 0 && side(r, s, p) * side(r, s, q) < 0;
}
/** Whether a segment goes through a box (taken in a little, so that touching does not count). */
function segmentInBox(p: Point, q: Point, box: Box): boolean {
  const b = { l: box.l + 3, t: box.t + 3, r: box.r - 3, b: box.b - 3 };
  if (b.l >= b.r || b.t >= b.b) return false;
  const inside = (x: Point) => x[0] > b.l && x[0] < b.r && x[1] > b.t && x[1] < b.b;
  if (inside(p) || inside(q)) return true;
  const corners: Point[] = [
    [b.l, b.t],
    [b.r, b.t],
    [b.r, b.b],
    [b.l, b.b],
  ];
  return corners.some((c, i) => segmentsCross(p, q, c, corners[(i + 1) % 4]!));
}

/**
 * What is wrong with how a drawing looks, said in words: boxes that run into each other,
 * arrows through boxes and across each other, labels over boxes, boxes that are nearly but
 * not quite in line, and rows or columns with uneven gaps.
 */
export function layoutNotes(elements: readonly DrawingElement[]): string[] {
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const boxes = live.filter(
    (e) => SHAPES.has(e.type) || e.type === 'image' || (e.type === 'text' && !e.containerId),
  );
  const notes: string[] = [];
  const MOST = 16;
  const say = (note: string) => {
    if (notes.length < MOST) notes.push(note);
    else if (notes.length === MOST) notes.push('More is not listed.');
  };
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxOf(boxes[i]!);
      const b = boxOf(boxes[j]!);
      if (!boxesMeet(a, b)) continue;
      // One within the other is a box around things: meant.
      const inside = (p: Box, q: Box) => p.l >= q.l && p.r <= q.r && p.t >= q.t && p.b <= q.b;
      if (inside(a, b) || inside(b, a)) continue;
      say(`${boxes[i]!.id} and ${boxes[j]!.id} overlap.`);
    }
  for (const e of live) {
    if (e.type !== 'text' || !e.containerId) continue;
    const c = byId.get(String(e.containerId));
    if (c && SHAPES.has(c.type) && (num(e.width) > num(c.width) || num(e.height) > num(c.height)))
      say(`The label of ${c.id} is larger than the shape.`);
  }
  // Arrows and lines: through boxes they do not join, and across each other.
  const lines = live
    .filter((e) => LINEAR.has(e.type))
    .map((e) => ({
      e,
      ends: [bindingOf(e, 'startBinding'), bindingOf(e, 'endBinding')],
      points: pointsOf(e).map(([px, py]): Point => [num(e.x) + px, num(e.y) + py]),
    }));
  const name = (l: (typeof lines)[number]) =>
    l.ends[0] && l.ends[1] ? `${l.e.id} (${l.ends[0]} to ${l.ends[1]})` : l.e.id;
  for (const line of lines)
    for (const box of boxes) {
      if (line.ends.includes(box.id)) continue;
      const b = boxOf(box);
      // A box around the whole of it is a frame for it, not in its way.
      if (line.points.every((p) => p[0] >= b.l && p[0] <= b.r && p[1] >= b.t && p[1] <= b.b))
        continue;
      if (line.points.some((p, i) => i > 0 && segmentInBox(line.points[i - 1]!, p, b)))
        say(`The ${line.e.type} ${name(line)} goes through ${box.id}.`);
    }
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      const crossing = a.points.some(
        (p, m) =>
          m > 0 &&
          b.points.some((q, n) => n > 0 && segmentsCross(a.points[m - 1]!, p, b.points[n - 1]!, q)),
      );
      if (crossing) say(`${name(a)} and ${name(b)} cross.`);
    }
  // Labels of arrows over boxes.
  for (const t of live) {
    if (t.type !== 'text' || !t.containerId) continue;
    const owner = byId.get(String(t.containerId));
    if (!owner || !LINEAR.has(owner.type)) continue;
    for (const box of boxes)
      if (boxesMeet(boxOf(t), boxOf(box))) say(`The label of ${owner.id} lies over ${box.id}.`);
  }
  // Nearly in line, and uneven gaps: among the shapes only.
  const shapes = live.filter((e) => SHAPES.has(e.type));
  const mid = (e: DrawingElement, axis: 'x' | 'y') =>
    axis === 'x' ? num(e.x) + num(e.width) / 2 : num(e.y) + num(e.height) / 2;
  for (const axis of ['x', 'y'] as const) {
    const other = axis === 'x' ? 'y' : 'x';
    for (let i = 0; i < shapes.length; i++)
      for (let j = i + 1; j < shapes.length; j++) {
        const off = Math.abs(mid(shapes[i]!, axis) - mid(shapes[j]!, axis));
        if (off >= 1 && off <= 12)
          say(
            `${shapes[i]!.id} and ${shapes[j]!.id} are almost in one ${axis === 'x' ? 'column' : 'row'} (${round(off)} apart): align them.`,
          );
      }
    // Those in one line: their gaps.
    const seen = new Set<string>();
    for (const first of shapes) {
      if (seen.has(first.id)) continue;
      const row = shapes
        .filter((e) => Math.abs(mid(e, axis) - mid(first, axis)) < 1)
        .sort((a, b) => mid(a, other) - mid(b, other));
      for (const e of row) seen.add(e.id);
      if (row.length < 3) continue;
      const gaps = row
        .slice(1)
        .map((e, i) =>
          other === 'x'
            ? num(e.x) - (num(row[i]!.x) + num(row[i]!.width))
            : num(e.y) - (num(row[i]!.y) + num(row[i]!.height)),
        );
      // Clearly so: boxes of different sizes on even centres have gaps that differ a little.
      if (Math.max(...gaps) > Math.max(0, Math.min(...gaps)) * 1.5 + 12)
        say(
          `The gaps in the ${axis === 'x' ? 'column' : 'row'} ${row.map((e) => e.id).join(', ')} are uneven (${gaps.map(round).join(', ')}): distribute them.`,
        );
    }
  }
  return notes;
}

// ---- changing --------------------------------------------------------------------------------

function base(
  id: string,
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
): DrawingElement {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: DEFAULT_STROKE,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: type === 'rectangle' || type === 'diamond' ? { type: 3 } : null,
    seed: random(),
    version: 1,
    versionNonce: random(),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function touch(e: DrawingElement): void {
  e.version = num(e.version) + 1;
  e.versionNonce = random();
  e.updated = Date.now();
}

/** Where the line from the middle of `e` towards `(tx, ty)` leaves its outline, and a little on. */
function edgePoint(e: DrawingElement, tx: number, ty: number): [number, number] {
  const hw = num(e.width) / 2;
  const hh = num(e.height) / 2;
  const cx = num(e.x) + hw;
  const cy = num(e.y) + hh;
  const dx = tx - cx;
  const dy = ty - cy;
  const length = Math.hypot(dx, dy);
  if (!length || !hw || !hh) return [cx, cy];
  const t =
    e.type === 'ellipse'
      ? 1 / Math.hypot(dx / hw, dy / hh)
      : e.type === 'diamond'
        ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
        : Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  const reach = Math.min(1, t + GAP / length);
  return [cx + dx * reach, cy + dy * reach];
}

/**
 * Applies the operations to a scene (which is changed in place) and says what was done.
 * Throws, with nothing to keep, when one of them cannot be done.
 */
export function applyDrawingOps(
  scene: Scene,
  ops: readonly DrawingOp[],
  measure: MeasureText = estimateText,
  options: { arrange?: Arrange } = {},
): string {
  const elements = scene.elements;
  const byId = new Map(elements.filter((e) => !e.isDeleted).map((e) => [e.id, e]));
  const taken = new Set(elements.map((e) => e.id));
  const done: string[] = [];
  const get = (id: unknown, what = 'element'): DrawingElement => {
    const e = byId.get(String(id ?? ''));
    if (!e) throw new Error(`There is no ${what} with the id "${String(id ?? '')}".`);
    return e;
  };
  const add = (e: DrawingElement) => {
    elements.push(e);
    byId.set(e.id, e);
    taken.add(e.id);
  };
  const bind = (target: DrawingElement, id: string, type: string) => {
    if (boundOf(target).some((b) => b.id === id)) return;
    target.boundElements = [...boundOf(target), { id, type }];
    touch(target);
  };
  const unbind = (target: DrawingElement | undefined, id: string) => {
    if (!target || !boundOf(target).some((b) => b.id === id)) return;
    target.boundElements = boundOf(target).filter((b) => b.id !== id);
    touch(target);
  };
  const labelOf = (e: DrawingElement): DrawingElement | undefined =>
    boundOf(e)
      .filter((b) => b.type === 'text')
      .map((b) => byId.get(b.id))
      .find((t) => t);

  const setText = (t: DrawingElement, text: string, fontSize?: number, math?: boolean) => {
    if (fontSize) t.fontSize = fontSize;
    t.text = text;
    t.originalText = text;
    // Math mode: the text is set by the drawing's formula renderer, in its own font.
    const wasMath = t.subtype === 'math';
    if (isMath(text, math ?? (wasMath ? true : undefined))) {
      t.subtype = 'math';
      t.customData = { ...((t.customData as object) ?? {}), useTex: true, mathOnly: false };
      t.fontFamily = 2;
    } else if (wasMath) {
      delete t.subtype;
      t.fontFamily = 5;
    }
    const size = measure(t.subtype === 'math' ? shownMath(text) : text, num(t.fontSize, 20));
    t.width = size.width;
    t.height = size.height;
    touch(t);
  };
  /** A label sits in the middle of what it labels; a shape grows to hold it. */
  const placeLabel = (owner: DrawingElement) => {
    const label = labelOf(owner);
    if (!label) return;
    if (SHAPES.has(owner.type)) {
      const room = owner.type === 'rectangle' ? 1 : 1.45;
      const needW = Math.ceil(num(label.width) * room + 2 * PADDING);
      const needH = Math.ceil(num(label.height) * room + 2 * PADDING);
      if (num(owner.width) < needW) {
        owner.x = num(owner.x) - (needW - num(owner.width)) / 2;
        owner.width = needW;
      }
      if (num(owner.height) < needH) {
        owner.y = num(owner.y) - (needH - num(owner.height)) / 2;
        owner.height = needH;
      }
      label.x = num(owner.x) + (num(owner.width) - num(label.width)) / 2;
      label.y = num(owner.y) + (num(owner.height) - num(label.height)) / 2;
    } else {
      // On an arrow: at the middle of its way.
      const points = pointsOf(owner);
      const a = points[Math.floor((points.length - 1) / 2)] ?? [0, 0];
      const b = points[Math.ceil((points.length - 1) / 2)] ?? a;
      label.x = num(owner.x) + (a[0] + b[0]) / 2 - num(label.width) / 2;
      label.y = num(owner.y) + (a[1] + b[1]) / 2 - num(label.height) / 2;
    }
    touch(label);
  };
  const giveLabel = (owner: DrawingElement, text: string, fontSize?: number, math?: boolean) => {
    let label = labelOf(owner);
    if (!text) {
      if (label) {
        label.isDeleted = true;
        touch(label);
        byId.delete(label.id);
        unbind(owner, label.id);
      }
      return;
    }
    if (!label) {
      label = {
        ...base(newId(taken), 'text', 0, 0, 0, 0),
        fontSize: fontSize ?? 20,
        fontFamily: 5,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: owner.id,
        lineHeight: LINE_HEIGHT,
        autoResize: true,
        strokeColor: owner.strokeColor ?? DEFAULT_STROKE,
      };
      add(label);
      bind(owner, label.id, 'text');
    }
    setText(label, text, fontSize, math);
    placeLabel(owner);
  };

  /** The way of an arrow between what it is bound to; other arrows keep theirs. */
  const sides = (e: DrawingElement) => ({
    l: num(e.x),
    t: num(e.y),
    r: num(e.x) + num(e.width),
    b: num(e.y) + num(e.height),
    cx: num(e.x) + num(e.width) / 2,
    cy: num(e.y) + num(e.height) / 2,
  });
  const fix = (arrow: DrawingElement, end: 'startBinding' | 'endBinding', at: [number, number]) => {
    const binding = arrow[end] as { fixedPoint?: [number, number] } | null;
    if (binding) binding.fixedPoint = at;
  };
  /**
   * The way of an arrow at right angles: out of the side of the one that faces the other, and
   * into the side that faces back, with one step between them where they are not in line.
   * False where the two overlap, and there is no such way.
   */
  const elbow = (arrow: DrawingElement, from: DrawingElement, to: DrawingElement): boolean => {
    const a = sides(from);
    const b = sides(to);
    const around = (arrow.customData as { route?: string } | undefined)?.route;
    if (around === 'around-right') {
      // Back up a flow that goes down: out to the right, up, and in from the right.
      const x = Math.max(a.r, b.r) + 40;
      fix(arrow, 'startBinding', [1, 0.5001]);
      fix(arrow, 'endBinding', [1, 0.5001]);
      setPoints(arrow, [
        [a.r + GAP, a.cy],
        [x, a.cy],
        [x, b.cy],
        [b.r + GAP, b.cy],
      ]);
      return true;
    }
    if (around === 'around-bottom') {
      const y = Math.max(a.b, b.b) + 40;
      fix(arrow, 'startBinding', [0.5001, 1]);
      fix(arrow, 'endBinding', [0.5001, 1]);
      setPoints(arrow, [
        [a.cx, a.b + GAP],
        [a.cx, y],
        [b.cx, y],
        [b.cx, b.b + GAP],
      ]);
      return true;
    }
    const gapX = Math.max(b.l - a.r, a.l - b.r);
    const gapY = Math.max(b.t - a.b, a.t - b.b);
    if (gapX <= 2 * GAP && gapY <= 2 * GAP) return false;
    if (gapY >= gapX) {
      const down = b.t >= a.b;
      const y1 = down ? a.b + GAP : a.t - GAP;
      const y2 = down ? b.t - GAP : b.b + GAP;
      const mid = down ? (a.b + b.t) / 2 : (a.t + b.b) / 2;
      // Nearly in line: one upright line where both can be met, not a step of a few pixels.
      const near = Math.abs(a.cx - b.cx) < Math.min(a.r - a.l, b.r - b.l) / 4;
      if (near && Math.abs(a.cx - b.cx) >= 1) {
        const x = (a.cx + b.cx) / 2;
        fix(arrow, 'startBinding', [(x - a.l) / (a.r - a.l), down ? 1 : 0]);
        fix(arrow, 'endBinding', [(x - b.l) / (b.r - b.l), down ? 0 : 1]);
        setPoints(arrow, [
          [x, y1],
          [x, y2],
        ]);
        return true;
      }
      fix(arrow, 'startBinding', [0.5001, down ? 1 : 0]);
      fix(arrow, 'endBinding', [0.5001, down ? 0 : 1]);
      setPoints(
        arrow,
        Math.abs(a.cx - b.cx) < 1
          ? [
              [a.cx, y1],
              [a.cx, y2],
            ]
          : [
              [a.cx, y1],
              [a.cx, mid],
              [b.cx, mid],
              [b.cx, y2],
            ],
      );
    } else {
      const right = b.l >= a.r;
      const x1 = right ? a.r + GAP : a.l - GAP;
      const x2 = right ? b.l - GAP : b.r + GAP;
      const mid = right ? (a.r + b.l) / 2 : (a.l + b.r) / 2;
      const near = Math.abs(a.cy - b.cy) < Math.min(a.b - a.t, b.b - b.t) / 4;
      if (near && Math.abs(a.cy - b.cy) >= 1) {
        const y = (a.cy + b.cy) / 2;
        fix(arrow, 'startBinding', [right ? 1 : 0, (y - a.t) / (a.b - a.t)]);
        fix(arrow, 'endBinding', [right ? 0 : 1, (y - b.t) / (b.b - b.t)]);
        setPoints(arrow, [
          [x1, y],
          [x2, y],
        ]);
        return true;
      }
      fix(arrow, 'startBinding', [right ? 1 : 0, 0.5001]);
      fix(arrow, 'endBinding', [right ? 0 : 1, 0.5001]);
      setPoints(
        arrow,
        Math.abs(a.cy - b.cy) < 1
          ? [
              [x1, a.cy],
              [x2, a.cy],
            ]
          : [
              [x1, a.cy],
              [mid, a.cy],
              [mid, b.cy],
              [x2, b.cy],
            ],
      );
    }
    return true;
  };
  /** The way of an arrow between what it is bound to; other arrows keep theirs. */
  const route = (arrow: DrawingElement) => {
    const from = byId.get(bindingOf(arrow, 'startBinding') ?? '');
    const to = byId.get(bindingOf(arrow, 'endBinding') ?? '');
    if (!from && !to) return;
    if (arrow.elbowed && from && to && from !== to && elbow(arrow, from, to)) return;
    const points = pointsOf(arrow).map(([px, py]): [number, number] => [
      num(arrow.x) + px,
      num(arrow.y) + py,
    ]);
    while (points.length < 2) points.push([num(arrow.x), num(arrow.y)]);
    const middle = (e: DrawingElement): [number, number] => [
      num(e.x) + num(e.width) / 2,
      num(e.y) + num(e.height) / 2,
    ];
    // An arrow at right angles that has no such way (its ends overlap) is one line.
    if (arrow.elbowed && from && to) points.splice(1, points.length - 2);
    // Each end looks to the point next to it, or to the middle of what the other end is at.
    const towardsStart = points.length > 2 ? points[1]! : to ? middle(to) : points[1]!;
    const towardsEnd =
      points.length > 2 ? points[points.length - 2]! : from ? middle(from) : points[0]!;
    if (from) points[0] = edgePoint(from, towardsStart[0], towardsStart[1]);
    if (to) points[points.length - 1] = edgePoint(to, towardsEnd[0], towardsEnd[1]);
    setPoints(arrow, points);
  };
  /** Straight, or at right angles (which the drawing then keeps so when its ends are moved). */
  const setRoute = (arrow: DrawingElement, how: string | undefined) => {
    if (how !== undefined && how !== 'elbow' && how !== 'straight')
      throw new Error('route is "elbow" or "straight".');
    const on = how === 'elbow';
    arrow.elbowed = on;
    arrow.roundness = on ? null : { type: 2 };
    if (on) {
      arrow.fixedSegments = null;
      arrow.startIsSpecial = null;
      arrow.endIsSpecial = null;
    } else {
      delete arrow.fixedSegments;
      delete arrow.startIsSpecial;
      delete arrow.endIsSpecial;
      if (arrow.customData) delete (arrow.customData as { route?: string }).route;
    }
  };
  const setPoints = (line: DrawingElement, absolute: Array<[number, number]>) => {
    const [ox, oy] = absolute[0]!;
    const points = absolute.map(([px, py]): [number, number] => [px - ox, py - oy]);
    line.x = ox;
    line.y = oy;
    line.points = points;
    line.width = Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]));
    line.height = Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]));
    touch(line);
    placeLabel(line);
  };
  const setEnd = (arrow: DrawingElement, end: 'startBinding' | 'endBinding', id: string | null) => {
    const old = byId.get(bindingOf(arrow, end) ?? '');
    if (old) unbind(old, arrow.id);
    if (id === null || id === '') {
      arrow[end] = null;
      return;
    }
    const target = get(id, 'element to join');
    if (LINEAR.has(target.type) || target.id === arrow.id)
      throw new Error(`An arrow cannot be joined to "${id}".`);
    arrow[end] = { elementId: target.id, fixedPoint: [0.5001, 0.5001], mode: 'orbit' };
    bind(target, arrow.id, 'arrow');
  };
  /** After a shape moved or changed size: its label and its arrows go along. */
  const follow = (e: DrawingElement) => {
    placeLabel(e);
    for (const b of boundOf(e)) {
      const arrow = b.type === 'arrow' ? byId.get(b.id) : undefined;
      if (arrow) route(arrow);
    }
  };
  const style = (e: DrawingElement, op: DrawingOp) => {
    if (op.stroke !== undefined) e.strokeColor = op.stroke;
    if (op.fill !== undefined) e.backgroundColor = op.fill;
    if (op.strokeStyle !== undefined) {
      if (!['solid', 'dashed', 'dotted'].includes(op.strokeStyle))
        throw new Error('strokeStyle is "solid", "dashed" or "dotted".');
      e.strokeStyle = op.strokeStyle;
    }
    if (op.strokeWidth !== undefined) e.strokeWidth = op.strokeWidth;
    if (op.opacity !== undefined) e.opacity = Math.max(0, Math.min(100, op.opacity));
    if (e.type === 'arrow') {
      if (op.startArrowhead !== undefined)
        e.startArrowhead = op.startArrowhead === 'none' ? null : op.startArrowhead;
      if (op.endArrowhead !== undefined)
        e.endArrowhead = op.endArrowhead === 'none' ? null : op.endArrowhead;
    }
  };
  const checkPoints = (points: unknown): Array<[number, number]> => {
    if (
      !Array.isArray(points) ||
      points.length < 2 ||
      !points.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => isFinite(v)))
    )
      throw new Error('points is a list of at least two [x, y] pairs.');
    return points as Array<[number, number]>;
  };

  /**
   * Lays out what the arrows join as a flowchart: each element one step further along than
   * the furthest of those that lead to it, the elements of a step side by side under (or
   * beside) what leads to them. Arrows that lead back go around. Returns how many were placed.
   */
  const arrange = (direction: Arrange): number => {
    const arrows = [...byId.values()].filter(
      (e) => e.type === 'arrow' && bindingOf(e, 'startBinding') && bindingOf(e, 'endBinding'),
    );
    const edges = arrows
      .map((e) => ({
        arrow: e,
        from: bindingOf(e, 'startBinding')!,
        to: bindingOf(e, 'endBinding')!,
      }))
      .filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to));
    const ids = [...byId.keys()].filter((id) => edges.some((e) => e.from === id || e.to === id));
    if (ids.length < 2) return 0;
    // Arrows that lead back to where the flow came from do not count for the steps.
    const back = new Set<DrawingElement>();
    const state = new Map<string, 'open' | 'done'>();
    const visit = (id: string) => {
      state.set(id, 'open');
      for (const e of edges) {
        if (e.from !== id) continue;
        if (state.get(e.to) === 'open') back.add(e.arrow);
        else if (!state.has(e.to)) visit(e.to);
      }
      state.set(id, 'done');
    };
    const forward = () => edges.filter((e) => !back.has(e.arrow));
    for (const id of ids) if (!edges.some((e) => e.to === id) && !state.has(id)) visit(id);
    for (const id of ids) if (!state.has(id)) visit(id);
    const step = new Map<string, number>(ids.map((id) => [id, 0]));
    for (let round = 0; round < ids.length; round++) {
      let changed = false;
      for (const e of forward())
        if (step.get(e.to)! < step.get(e.from)! + 1) {
          step.set(e.to, step.get(e.from)! + 1);
          changed = true;
        }
      if (!changed) break;
    }
    const down = direction === 'down';
    const along = (e: DrawingElement) => (down ? num(e.height) : num(e.width));
    const across = (e: DrawingElement) => (down ? num(e.width) : num(e.height));
    const before = ids.map((id) => byId.get(id)!);
    const originX = Math.min(...before.map((e) => num(e.x)));
    const originY = Math.min(...before.map((e) => num(e.y)));
    const centre = new Map<string, number>();
    const start = new Map<string, number>();
    const slot = Math.max(...before.map(across)) + 60;
    let offset = 0;
    const steps = Math.max(...step.values());
    for (let n = 0; n <= steps; n++) {
      const row = ids.filter((id) => step.get(id) === n);
      // Under the middle of what leads here; those that nothing leads to, in their order.
      const wanted = new Map(
        row.map((id) => {
          const parents = forward()
            .filter((e) => e.to === id && centre.has(e.from))
            .map((e) => centre.get(e.from)!);
          return [
            id,
            parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : undefined,
          ];
        }),
      );
      row.sort((a, b) => (wanted.get(a) ?? Infinity) - (wanted.get(b) ?? Infinity));
      // In slots of one width, so that what is under one another is exactly so.
      let last = -Infinity;
      for (const id of row) {
        const want = wanted.get(id) ?? (last === -Infinity ? 0 : last + slot);
        centre.set(id, last === -Infinity ? want : Math.max(want, last + slot));
        last = centre.get(id)!;
      }
      // As a group, in the middle of where its members wanted to be (by half slots).
      const known = row.filter((id) => wanted.get(id) !== undefined);
      const shift = known.length
        ? known.reduce((sum, id) => sum + wanted.get(id)! - centre.get(id)!, 0) / known.length
        : -(centre.get(row[0]!)! + centre.get(row[row.length - 1]!)!) / 2;
      const snapped = Math.round(shift / (slot / 2)) * (slot / 2);
      for (const id of row) centre.set(id, centre.get(id)! + snapped);
      const size = Math.max(...row.map((id) => along(byId.get(id)!)));
      for (const id of row) start.set(id, offset + (size - along(byId.get(id)!)) / 2);
      offset += size + 80;
    }
    const least = Math.min(...ids.map((id) => centre.get(id)! - across(byId.get(id)!) / 2));
    for (const id of ids) {
      const e = byId.get(id)!;
      const c = centre.get(id)! - least - across(e) / 2;
      e.x = originX + (down ? c : start.get(id)!);
      e.y = originY + (down ? start.get(id)! : c);
      touch(e);
    }
    for (const e of edges) {
      if (!e.arrow.elbowed) continue;
      const custom = { ...((e.arrow.customData as object) ?? {}) } as { route?: string };
      if (back.has(e.arrow)) custom.route = down ? 'around-right' : 'around-bottom';
      else delete custom.route;
      e.arrow.customData = custom;
    }
    for (const id of ids) placeLabel(byId.get(id)!);
    for (const e of edges) route(e.arrow);
    return ids.length;
  };

  for (const op of ops) {
    if (op.op === 'add') {
      const type = String(op.type ?? '');
      if (!SHAPES.has(type) && !LINEAR.has(type) && type !== 'text')
        throw new Error(
          `To add: a "rectangle", "ellipse", "diamond", "text", "arrow" or "line" (not "${type}").`,
        );
      let id = op.id ? String(op.id) : newId(taken);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id))
        throw new Error(`"${id}" cannot be an id: letters, digits, - and _ only.`);
      if (taken.has(id)) throw new Error(`The id "${id}" is taken.`);
      if (LINEAR.has(type)) {
        const line: DrawingElement = {
          ...base(id, type, 0, 0, 0, 0),
          points: [
            [0, 0],
            [0, 0],
          ],
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: type === 'arrow' ? 'arrow' : null,
          roundness: { type: 2 },
          ...(type === 'arrow' ? { elbowed: false } : { polygon: false }),
        };
        add(line);
        const bound = type === 'arrow' && (op.from || op.to);
        if (!bound && !op.points)
          throw new Error(
            type === 'arrow'
              ? 'An arrow needs "from" and "to" (ids), or "points".'
              : 'A line needs "points".',
          );
        if (op.points) setPoints(line, checkPoints(op.points));
        if (type === 'arrow') {
          if (op.from) setEnd(line, 'startBinding', String(op.from));
          if (op.to) setEnd(line, 'endBinding', String(op.to));
          // Between two elements: at right angles, unless a way or a straight line is asked for.
          if (op.route !== undefined) setRoute(line, op.route);
          else if (op.from && op.to && !op.points) setRoute(line, 'elbow');
          // Between two elements and with no way given: straight from the one to the other.
          if (!op.points) {
            const a = byId.get(bindingOf(line, 'startBinding') ?? '');
            const b = byId.get(bindingOf(line, 'endBinding') ?? '');
            if (!a || !b) throw new Error('An arrow with one end free needs "points".');
            setPoints(line, [
              [num(a.x) + num(a.width) / 2, num(a.y) + num(a.height) / 2],
              [num(b.x) + num(b.width) / 2, num(b.y) + num(b.height) / 2],
            ]);
          }
          route(line);
        }
        style(line, op);
        if (op.text) giveLabel(line, op.text, op.fontSize, op.math);
      } else if (type === 'text') {
        if (!op.text) throw new Error('A text needs "text".');
        const text: DrawingElement = {
          ...base(id, 'text', num(op.x), num(op.y), 0, 0),
          fontSize: op.fontSize ?? 20,
          fontFamily: 5,
          textAlign: 'left',
          verticalAlign: 'top',
          containerId: null,
          lineHeight: LINE_HEIGHT,
          autoResize: true,
        };
        add(text);
        style(text, op);
        setText(text, op.text, undefined, op.math);
      } else {
        const shape = base(id, type, num(op.x), num(op.y), num(op.width, 160), num(op.height, 70));
        add(shape);
        style(shape, op);
        if (op.text) giveLabel(shape, op.text, op.fontSize, op.math);
      }
      done.push(`added ${type} ${id}`);
      id = '';
    } else if (op.op === 'update') {
      const e = get(op.id);
      if (e.type === 'text' && e.containerId)
        throw new Error(`"${e.id}" is a label: change the "text" of ${String(e.containerId)}.`);
      style(e, op);
      if (LINEAR.has(e.type)) {
        if (e.type === 'arrow') {
          if (op.from !== undefined) setEnd(e, 'startBinding', op.from);
          if (op.to !== undefined) setEnd(e, 'endBinding', op.to);
          if (op.route !== undefined) setRoute(e, op.route);
          // A way given by hand is kept as it is given.
          else if (op.points && e.elbowed) setRoute(e, 'straight');
        }
        if (op.points) setPoints(e, checkPoints(op.points));
        else if (op.x !== undefined || op.y !== undefined) {
          e.x = num(op.x, num(e.x));
          e.y = num(op.y, num(e.y));
        }
        route(e);
        if (op.text !== undefined) giveLabel(e, op.text, op.fontSize, op.math);
        else placeLabel(e);
      } else {
        const dx = num(op.x, num(e.x)) - num(e.x);
        const dy = num(op.y, num(e.y)) - num(e.y);
        e.x = num(e.x) + dx;
        e.y = num(e.y) + dy;
        if (op.width !== undefined) e.width = op.width;
        if (op.height !== undefined) e.height = op.height;
        if (e.type === 'text') {
          if (op.text !== undefined || op.fontSize !== undefined || op.math !== undefined)
            setText(e, op.text ?? String(e.originalText ?? e.text ?? ''), op.fontSize, op.math);
        } else if (op.text !== undefined) giveLabel(e, op.text, op.fontSize, op.math);
        else if (op.fontSize !== undefined) {
          const label = labelOf(e);
          if (label) setText(label, String(label.originalText ?? label.text ?? ''), op.fontSize);
        }
        // What is in a frame moves with it.
        if ((e.type === 'frame' || e.type === 'magicframe') && (dx || dy))
          for (const child of byId.values())
            if (child.frameId === e.id && !(child.type === 'text' && child.containerId)) {
              if (LINEAR.has(child.type)) {
                child.x = num(child.x) + dx;
                child.y = num(child.y) + dy;
                touch(child);
                placeLabel(child);
              } else {
                child.x = num(child.x) + dx;
                child.y = num(child.y) + dy;
                touch(child);
                follow(child);
              }
            }
        follow(e);
      }
      touch(e);
      done.push(`updated ${e.id}`);
    } else if (op.op === 'delete') {
      const e = get(op.id);
      if (e.type === 'text' && e.containerId) {
        const owner = byId.get(String(e.containerId));
        if (owner) unbind(owner, e.id);
      }
      for (const b of boundOf(e)) {
        const other = byId.get(b.id);
        if (!other) continue;
        if (b.type === 'text') {
          other.isDeleted = true;
          touch(other);
          byId.delete(other.id);
        } else {
          // An arrow that came here ends where it ended, joined to nothing.
          for (const end of ['startBinding', 'endBinding'] as const)
            if (bindingOf(other, end) === e.id) other[end] = null;
          touch(other);
        }
      }
      if (e.type === 'arrow')
        for (const end of ['startBinding', 'endBinding'] as const)
          unbind(byId.get(bindingOf(e, end) ?? ''), e.id);
      e.isDeleted = true;
      touch(e);
      byId.delete(e.id);
      done.push(`deleted ${e.id}`);
    } else if (
      op.op === 'align' ||
      op.op === 'distribute' ||
      op.op === 'group' ||
      op.op === 'ungroup' ||
      op.op === 'order'
    ) {
      const chosen = (op.ids ?? (op.id ? [op.id] : [])).map((id) => get(id));
      // A label goes where what it labels goes: it is not chosen by itself.
      const label = chosen.find((e) => e.type === 'text' && e.containerId);
      if (label) throw new Error(`"${label.id}" is a label: name ${String(label.containerId)}.`);
      const least = op.op === 'order' || op.op === 'ungroup' ? 1 : op.op === 'distribute' ? 3 : 2;
      if (new Set(chosen.map((e) => e.id)).size < least)
        throw new Error(`"${op.op}" needs the "ids" of at least ${least} elements.`);
      const moveBy = (e: DrawingElement, dx: number, dy: number) => {
        if (!dx && !dy) return;
        e.x = num(e.x) + dx;
        e.y = num(e.y) + dy;
        touch(e);
        if (LINEAR.has(e.type)) placeLabel(e);
        else follow(e);
      };
      if (op.op === 'align') {
        // To the edge or the middle of all of them together, as the drawing's own "align" does.
        const l = Math.min(...chosen.map((e) => num(e.x)));
        const r = Math.max(...chosen.map((e) => num(e.x) + num(e.width)));
        const t = Math.min(...chosen.map((e) => num(e.y)));
        const b = Math.max(...chosen.map((e) => num(e.y) + num(e.height)));
        for (const e of chosen) {
          const w = num(e.width);
          const hgt = num(e.height);
          if (op.align === 'left') moveBy(e, l - num(e.x), 0);
          else if (op.align === 'right') moveBy(e, r - w - num(e.x), 0);
          else if (op.align === 'center') moveBy(e, (l + r) / 2 - w / 2 - num(e.x), 0);
          else if (op.align === 'top') moveBy(e, 0, t - num(e.y));
          else if (op.align === 'bottom') moveBy(e, 0, b - hgt - num(e.y));
          else if (op.align === 'middle') moveBy(e, 0, (t + b) / 2 - hgt / 2 - num(e.y));
          else
            throw new Error(
              '"align" is "left", "center", "right" (in a column) or "top", "middle", "bottom" (in a row).',
            );
        }
        done.push(`aligned ${chosen.map((e) => e.id).join(', ')} ${op.align}`);
      } else if (op.op === 'distribute') {
        const across = op.direction === 'horizontal';
        if (!across && op.direction !== 'vertical')
          throw new Error('"direction" is "horizontal" or "vertical".');
        const at = (e: DrawingElement) => (across ? num(e.x) : num(e.y));
        const size = (e: DrawingElement) => (across ? num(e.width) : num(e.height));
        const row = [...chosen].sort((a, b) => at(a) + size(a) / 2 - (at(b) + size(b) / 2));
        const first = row[0]!;
        const last = row[row.length - 1]!;
        // Between the outer two as they stand, or with the gap that is given.
        const gap =
          op.gap ??
          (at(last) + size(last) - at(first) - row.reduce((sum, e) => sum + size(e), 0)) /
            (row.length - 1);
        let next = at(first);
        for (const e of row) {
          moveBy(e, across ? next - num(e.x) : 0, across ? 0 : next - num(e.y));
          next += size(e) + gap;
        }
        done.push(
          `distributed ${row.map((e) => e.id).join(', ')} ${op.direction}, ${round(gap)} apart`,
        );
      } else if (op.op === 'group' || op.op === 'ungroup') {
        // With their labels: a shape and its text are selected as one.
        const members = chosen.flatMap((e) => [e, ...(labelOf(e) ? [labelOf(e)!] : [])]);
        const groupsOf = (e: DrawingElement) =>
          Array.isArray(e.groupIds) ? (e.groupIds as string[]) : [];
        if (op.op === 'group') {
          const group = newId(taken);
          taken.add(group);
          for (const e of members) {
            e.groupIds = [...groupsOf(e), group];
            touch(e);
          }
        } else
          for (const e of members) {
            if (!groupsOf(e).length) continue;
            e.groupIds = groupsOf(e).slice(0, -1);
            touch(e);
          }
        done.push(
          `${op.op === 'group' ? 'grouped' : 'ungrouped'} ${chosen.map((e) => e.id).join(', ')}`,
        );
      } else {
        if (op.position !== 'front' && op.position !== 'back')
          throw new Error('"position" is "front" or "back".');
        const moving = new Set(chosen.flatMap((e) => [e, ...(labelOf(e) ? [labelOf(e)!] : [])]));
        const rest = elements.filter((e) => !moving.has(e));
        const moved = elements.filter((e) => moving.has(e));
        elements.splice(
          0,
          elements.length,
          ...(op.position === 'front' ? [...rest, ...moved] : [...moved, ...rest]),
        );
        // The order is the order of the list from here on: the drawing numbers it anew.
        for (const e of elements) {
          e.index = null;
          touch(e);
        }
        done.push(`moved ${chosen.map((e) => e.id).join(', ')} to the ${op.position}`);
      }
    } else
      throw new Error(
        `"op" is "add", "update", "delete", "align", "distribute", "group", "ungroup" or "order" (not "${String(op.op)}").`,
      );
  }
  if (options.arrange) {
    if (options.arrange !== 'down' && options.arrange !== 'right')
      throw new Error('arrange is "down" or "right".');
    const moved = arrange(options.arrange);
    if (moved) done.push(`arranged ${moved} elements as a flow ${options.arrange}`);
  }
  if (!done.length) throw new Error('No operations were given.');
  const notes = layoutNotes(elements);
  return (
    `Done: ${done.join(', ')}.` +
    (notes.length ? `\nLayout notes:\n${notes.map((n) => `- ${n}`).join('\n')}` : '')
  );
}
