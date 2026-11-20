import { parse, parseDocument } from 'yaml';

/** What a `frame` block asks for. */
export interface FrameSpec {
  /** The HTML file: a link target, a path, or a frame's name (see `entryCandidates`). */
  file: string;
  caption?: string;
  /** Width in pixels; without it the frame is as wide as the text. */
  width?: number;
  /** Fixed height in pixels; without it the frame takes the height of its content. */
  height?: number;
  /** Everything else: handed to the HTML file as its settings. */
  settings: Record<string, unknown>;
}

const WHOLE_LINK = /^!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/;

/** The target of a string that is exactly one `[[link]]`, else undefined. */
export function linkTarget(value: string): string | undefined {
  return WHOLE_LINK.exec(value.trim())?.[1]?.trim();
}

/**
 * In YAML `[[a]]` is a list in a list; quote links so they stay text (and may contain commas
 * and colons).
 */
export function quoteLinks(yaml: string): string {
  return yaml.replace(
    /(^|[\s:[,-])(\[\[[^[\]\n]+\]\])(?=\s*(?:[,\]}#]|$))/gm,
    (_, before, link) => `${before}${JSON.stringify(link)}`,
  );
}

/** A Markdown link to a web resource, `[Lucy](https://…)`, would be a YAML list too: quote it. */
export function quoteWebLinks(yaml: string): string {
  return yaml.replace(
    /(^|[\s:[,-])(\[[^[\]\n]*\]\(https?:\/\/[^)\s]+\))(?=\s*(?:[,\]}#]|$))/gm,
    (_, before, link) => `${before}${JSON.stringify(link)}`,
  );
}

/**
 * The address of a string that is exactly one reference to a web resource, written as a
 * Markdown link `[label](https://…)` or `<https://…>`. A bare address stays ordinary text.
 */
export function webTarget(value: string): string | undefined {
  const v = value.trim();
  return (
    /^!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/.exec(v)?.[1] ?? /^<(https?:\/\/[^>\s]+)>$/.exec(v)?.[1]
  );
}

/** A value of a frame's settings that refers to a file: in the vault, or on the web. */
export interface FileRef {
  kind: 'vault' | 'web';
  /** The link target, or the address. */
  target: string;
  /** The value as written. */
  raw: string;
}

/**
 * A frame block: YAML with `file` (the HTML file), optional `caption`, `width` and `height`; every
 * other key is a setting of the HTML file.
 */
export function parseFrameBlock(source: string): FrameSpec {
  let value: unknown;
  try {
    value = parse(quoteWebLinks(quoteLinks(source)));
  } catch (e) {
    throw new Error(`This frame block is not valid YAML: ${e instanceof Error ? e.message : e}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A frame block needs a line like "file: [[frames/name/index.html]]".');
  const { file, caption, height, width, ...settings } = value as Record<string, unknown>;
  if (typeof file !== 'string' || !file.trim())
    throw new Error('A frame block needs a line like "file: [[frames/name/index.html]]".');
  const h = typeof height === 'number' ? height : Number.parseFloat(String(height ?? ''));
  const w = typeof width === 'number' ? width : Number.parseFloat(String(width ?? ''));
  return {
    file: linkTarget(file) ?? file.trim(),
    ...(typeof caption === 'string' && caption ? { caption } : {}),
    ...(Number.isFinite(w) && w > 0 ? { width: Math.max(40, w) } : {}),
    ...(Number.isFinite(h) && h > 0 ? { height: Math.min(4000, Math.max(40, h)) } : {}),
    settings,
  };
}

/** Settings written after the `#` of an embed: `![[plot.html#color=red&points=20]]`. */
export function parseFrameQuery(subpath: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!subpath) return result;
  for (const [key, value] of new URLSearchParams(subpath.replace(/^#/, ''))) {
    if (key) result[key] = value;
  }
  return result;
}

/** Where the HTML file named in a block may be, most specific first. */
export function entryCandidates(file: string, framesFolder: string): string[] {
  const clean = file.replace(/^\/+|\/+$/g, '');
  const isHtml = /\.html?$/i.test(clean);
  const inFolder = framesFolder ? `${framesFolder}/${clean}` : clean;
  return [
    ...(isHtml
      ? [clean, inFolder]
      : [`${clean}/index.html`, `${inFolder}/index.html`, `${clean}.html`, `${inFolder}.html`]),
  ].filter((p, i, all) => all.indexOf(p) === i);
}

/**
 * Replaces every string that is exactly one reference to a file (a `[[link]]`, or a Markdown
 * link to a web resource), at any depth, through `resolve`.
 */
export async function mapRefs(
  value: unknown,
  resolve: (ref: FileRef) => Promise<unknown>,
): Promise<unknown> {
  if (typeof value === 'string') {
    const target = linkTarget(value);
    if (target !== undefined) return resolve({ kind: 'vault', target, raw: value });
    const web = webTarget(value);
    return web === undefined ? value : resolve({ kind: 'web', target: web, raw: value });
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => mapRefs(v, resolve)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([k, v]) => [k, await mapRefs(v, resolve)] as const),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/** A name for a new frame's folder: lowercase words joined by dashes. */
export function frameSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Keys of a frame block that are not settings of the HTML file. */
export const RESERVED = ['file', 'caption', 'width', 'height'];

/** References are written bare in a block (`[[a]]`, not `"[[a]]"`). */
function unquoteRefs(yaml: string): string {
  return yaml
    .replace(/"(\[\[[^\]"\n]+\]\])"/g, '$1')
    .replace(/'(\[\[[^\]'\n]+\]\])'/g, '$1')
    .replace(/"(\[[^\]"\n]*\]\(https?:\/\/[^)"\s]+\))"/g, '$1')
    .replace(/"(<https?:\/\/[^>"\s]+>)"/g, '$1');
}

/**
 * The YAML of a frame block with its settings replaced: `file`, `caption`, `width` and
 * `height` stay as written, every other key becomes what `settings` says.
 */
export function withSettings(yaml: string, settings: Record<string, unknown>): string {
  const doc = parseDocument(quoteWebLinks(quoteLinks(yaml)));
  const current = doc.toJS() as Record<string, unknown> | null;
  for (const key of Object.keys(current ?? {})) {
    if (!RESERVED.includes(key) && !(key in settings)) doc.delete(key);
  }
  for (const [key, value] of Object.entries(settings)) {
    if (!RESERVED.includes(key)) doc.set(key, value);
  }
  return unquoteRefs(doc.toString({ lineWidth: 0 })).replace(/\n+$/, '');
}

/** A whole frame block, written from a spec (used when an embed needs more than it can say). */
export function blockText(spec: FrameSpec): string {
  const head = [
    `file: [[${spec.file}]]`,
    ...(spec.caption ? [`caption: ${JSON.stringify(spec.caption)}`] : []),
    ...(spec.width ? [`width: ${Math.round(spec.width)}`] : []),
    ...(spec.height ? [`height: ${Math.round(spec.height)}`] : []),
  ].join('\n');
  return `\`\`\`frame\n${withSettings(head, spec.settings)}\n\`\`\``;
}

/**
 * The inner lines of the fenced block that starts at line `start` of `lines` (the fence
 * itself), or undefined if that is not a frame block.
 */
export function frameFence(
  lines: string[],
  start: number,
): { first: number; last: number } | undefined {
  const open = /^(\s*)(`{3,}|~{3,})\s*frame\s*$/.exec(lines[start] ?? '');
  if (!open) return undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]!);
    if (close && close[1]![0] === open[2]![0] && close[1]!.length >= open[2]!.length)
      return { first: start + 1, last: i - 1 };
  }
  return undefined;
}

/** Whether a value (at any depth) is written as a reference to a file. */
export function hasRef(value: unknown): boolean {
  if (typeof value === 'string')
    return linkTarget(value) !== undefined || webTarget(value) !== undefined;
  if (Array.isArray(value)) return value.some(hasRef);
  if (value && typeof value === 'object') return Object.values(value).some(hasRef);
  return false;
}
