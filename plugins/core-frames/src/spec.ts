import { parse } from 'yaml';

/** What a `frame` block asks for. */
export interface FrameSpec {
  /** The HTML file: a link target, a path, or a frame's name (see `entryCandidates`). */
  file: string;
  caption?: string;
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

/**
 * A frame block: YAML with `file` (the HTML file), optional `caption` and `height`; every
 * other key is a setting of the HTML file.
 */
export function parseFrameBlock(source: string): FrameSpec {
  let value: unknown;
  try {
    value = parse(quoteLinks(source));
  } catch (e) {
    throw new Error(`This frame block is not valid YAML: ${e instanceof Error ? e.message : e}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A frame block needs a line like "file: [[frames/name/index.html]]".');
  const { file, caption, height, ...settings } = value as Record<string, unknown>;
  if (typeof file !== 'string' || !file.trim())
    throw new Error('A frame block needs a line like "file: [[frames/name/index.html]]".');
  const h = typeof height === 'number' ? height : Number.parseFloat(String(height ?? ''));
  return {
    file: linkTarget(file) ?? file.trim(),
    ...(typeof caption === 'string' && caption ? { caption } : {}),
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

/** Replaces every string that is exactly one `[[link]]` (at any depth) through `resolve`. */
export async function mapLinks(
  value: unknown,
  resolve: (target: string, raw: string) => Promise<unknown>,
): Promise<unknown> {
  if (typeof value === 'string') {
    const target = linkTarget(value);
    return target === undefined ? value : resolve(target, value);
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => mapLinks(v, resolve)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([k, v]) => [k, await mapLinks(v, resolve)] as const),
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
