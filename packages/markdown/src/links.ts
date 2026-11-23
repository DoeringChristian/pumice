/** Note IDs and the wikilink grammar shared by both parsers. */

/** Crockford base32, lowercase (no i, l, o, u). */
export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const ID_LENGTH = 10;
export const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{10}$/;

export function isNoteId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** A random 50-bit ID. */
export function generateId(random: (bytes: Uint8Array) => Uint8Array = cryptoRandom): string {
  const bytes = random(new Uint8Array(ID_LENGTH));
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b & 31];
  return id;
}

function cryptoRandom(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}

export interface WikiLinkParts {
  /** Text before `#` and `|`; empty for same-note links like `[[#Heading]]`. */
  target: string;
  /** Heading path (`H1#H2`) or block reference (`^id`), without the leading `#`. */
  subpath?: string;
  /** Text after `|`: display text for links, size (`300`, `300x200`) or alt text for embeds. */
  alias?: string;
}

/**
 * Splits the inside of `[[...]]`. The first `|` (or `\|`, as needed in tables) separates the
 * alias; the first `#` in the rest starts the subpath.
 */
export function parseWikiLinkContent(content: string): WikiLinkParts {
  const pipe = /\\?\|/.exec(content);
  const main = pipe ? content.slice(0, pipe.index) : content;
  const alias = pipe ? content.slice(pipe.index + pipe[0].length) : undefined;
  const hash = main.indexOf('#');
  const target = (hash >= 0 ? main.slice(0, hash) : main).trim();
  const subpath = hash >= 0 ? main.slice(hash + 1).trim() : undefined;
  const parts: WikiLinkParts = { target };
  if (subpath) parts.subpath = subpath;
  if (alias !== undefined) parts.alias = alias.trim();
  return parts;
}

/** Builds link text, escaping `|` for use inside table cells when asked. */
export function formatWikiLink(
  parts: WikiLinkParts,
  opts: { embed?: boolean; inTable?: boolean } = {},
): string {
  let inner = parts.target;
  if (parts.subpath) inner += `#${parts.subpath}`;
  if (parts.alias !== undefined && parts.alias !== '') {
    inner += `${opts.inTable ? '\\|' : '|'}${parts.alias}`;
  }
  return `${opts.embed ? '!' : ''}[[${inner}]]`;
}

/**
 * The width of the text in the app's page, in pixels: what a size without a unit is measured
 * against. `|350` is half of the line wherever the note is shown (a narrow window, a phone,
 * an exported page), as it is half of the line in the app at its usual width.
 */
export const TEXT_WIDTH = 700;

/** A length of an embed's size: a number with its unit; no unit for a plain number. */
export interface EmbedLength {
  value: number;
  unit: string;
}

export interface EmbedSize {
  /** The width and height when they are plain numbers (`300`, `300x200`). */
  width?: number;
  height?: number;
  /** The same with their units, also for `50%`, `20em`, `30vw`, `3cm` and the like. */
  w?: EmbedLength;
  h?: EmbedLength;
}

const UNITS = '%|px|em|rem|vw|vh|vmin|vmax|ch|cm|mm|in|pt|pc';
const SIZE = new RegExp(`^(?:(\\d*\\.?\\d+)(${UNITS})?)?(?:x(\\d*\\.?\\d+)(${UNITS})?)?$`, 'i');

/**
 * Parses the size of an embed. As in Obsidian it is the last part of the alias: `300` or
 * `300x200`, also after a caption (`Fig 1|300`). A number may carry a unit (`50%`, `20em`,
 * `10rem`, `40vw`, `30vh`, `300px`, `3cm`).
 */
export function parseEmbedSize(alias: string | undefined): EmbedSize {
  const last = alias?.split('|').pop()?.trim();
  const m = last ? SIZE.exec(last) : null;
  if (!m || (m[1] === undefined && m[3] === undefined)) return {};
  const length = (value?: string, unit?: string): EmbedLength | undefined =>
    value === undefined ? undefined : { value: Number(value), unit: (unit ?? '').toLowerCase() };
  const w = length(m[1], m[2]);
  const h = length(m[3], m[4]);
  return {
    ...(w && !w.unit ? { width: w.value } : {}),
    ...(h && !h.unit ? { height: h.value } : {}),
    ...(w ? { w } : {}),
    ...(h ? { h } : {}),
  };
}

/**
 * A size as CSS. A width without a unit is a share of the text's width (see `TEXT_WIDTH`):
 * of `--pm-text-w` where the page says how wide its text is, else of what the embed stands
 * in. A height without a unit is in pixels; with a width without a unit too (`300x200`) the
 * two give the proportions instead, so the picture keeps them at any width.
 */
export function embedSizeCss(size: EmbedSize): {
  width?: string;
  height?: string;
  aspectRatio?: string;
} {
  const css = (l: EmbedLength) => `${l.value}${l.unit}`;
  const out: { width?: string; height?: string; aspectRatio?: string } = {};
  if (size.w)
    out.width = size.w.unit
      ? css(size.w)
      : `calc(var(--pm-text-w, 100%) * ${+(size.w.value / TEXT_WIDTH).toFixed(5)})`;
  if (size.h) {
    if (size.h.unit) out.height = css(size.h);
    else if (size.w && !size.w.unit && size.w.value > 0 && size.h.value > 0)
      out.aspectRatio = `${size.w.value} / ${size.h.value}`;
    else out.height = `${size.h.value}px`;
  }
  return out;
}

/**
 * The inside of an embed (`target#sub|alias`, without the brackets) with its size set:
 * `|300` or `|300x200`, replacing a size that is there and keeping a caption.
 */
export function setEmbedSize(inner: string, size: { width: number; height?: number }): string {
  // In a table cell the bar is written `\|`.
  const sep = /\\\|/.test(inner) ? '\\|' : '|';
  const parts = inner.split(/\\?\|/);
  const spec = `${Math.round(size.width)}${size.height ? `x${Math.round(size.height)}` : ''}`;
  if (parts.length > 1 && isEmbedSize(parts[parts.length - 1]!)) parts.pop();
  return [...parts, spec].join(sep);
}

/**
 * Attributes after an image as pandoc writes them, `{width=50% height=3cm}`, at the start of
 * `text` (what follows the image). Gives how much of `text` they are and the size they say,
 * as it is written in an alias (`50%x3cm`); undefined if there is no such block. Classes,
 * identifiers and other keys are read over.
 */
export function parseImageAttributes(text: string): { length: number; size?: string } | undefined {
  const block = /^\{([^{}\n]*)\}/.exec(text);
  if (!block) return undefined;
  let width: string | undefined;
  let height: string | undefined;
  let known = false;
  for (const part of block[1]!.matchAll(
    /([.#][\w-]+)|([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g,
  )) {
    known = true;
    if (!part[2]) continue;
    const value = (part[3] ?? part[4] ?? part[5] ?? '').trim().replace(/inch$/i, 'in');
    if (!new RegExp(`^\\d*\\.?\\d+(${UNITS})?$`, 'i').test(value)) continue;
    if (part[2].toLowerCase() === 'width') width = value;
    else if (part[2].toLowerCase() === 'height') height = value;
  }
  // `{}` and text in braces that is no attribute list stay text.
  if (!known) return undefined;
  const size = width || height ? `${width ?? ''}${height ? `x${height}` : ''}` : undefined;
  return { length: block[0].length, ...(size ? { size } : {}) };
}

/**
 * An attribute block (`{width=50% .wide}`) without its width and height: what is left of it
 * when the size is written into the embed itself. Empty when nothing else was in it.
 */
export function withoutImageSize(block: string): string {
  const rest = block
    .slice(1, -1)
    .replace(/(^|\s)(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return rest ? `{${rest}}` : '';
}

/** Whether a part of an alias is a size (`300`, `300x200`, `50%`). */
export function isEmbedSize(text: string): boolean {
  const part = text.trim();
  return !!part && SIZE.test(part);
}

/** An alias with a size put at its end (replacing one that is there). */
export function withAliasSize(alias: string | undefined, size: string): string {
  const parts = alias ? alias.split('|') : [];
  if (parts.length && isEmbedSize(parts[parts.length - 1]!)) parts.pop();
  return [...parts, size].join('|');
}

/** Obsidian-style heading match: case-insensitive, ignoring punctuation and spacing differences. */
export function headingKey(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\-_.,:;!?'"`()[\]{}<>|\\/*#^]+/g, ' ')
    .trim();
}

/** Callout marker at the start of a blockquote: `[!type]`, `[!type]-`, `[!type]+`. */
export const CALLOUT_MARKER = /^\[!([^\]\s]+)\]([+-]?)/;
