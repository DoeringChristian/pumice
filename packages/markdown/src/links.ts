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

/** Parses an embed size alias: `300` → width, `300x200` → width and height. */
export function parseEmbedSize(alias: string | undefined): { width?: number; height?: number } {
  const m = alias ? /^(\d+)(?:x(\d+))?$/.exec(alias.trim()) : null;
  if (!m) return {};
  return { width: Number(m[1]), ...(m[2] ? { height: Number(m[2]) } : {}) };
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
