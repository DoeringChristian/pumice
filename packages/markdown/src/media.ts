/**
 * Media in the text of a note. `![[file|Caption]]` and `![Caption](file)` are two spellings of one
 * thing: what is shown (a file of the vault, or an address on the web), its caption, and its
 * attributes behind it as pandoc writes them, `{#fig-a width=50%}`. A size at the end of the
 * caption (`|300`, as Obsidian has it) is read, not written.
 */
import {
  TEXT_WIDTH,
  embedPattern,
  imagePattern,
  imageTarget,
  isEmbedSize,
  parseEmbedSize,
  parseImageAttributes,
  withAliasSize,
  type EmbedSize,
} from './links';

const FILE =
  /\.(png|apng|jpe?g|jfif|gif|webp|svg|bmp|avif|ico|mp4|m4v|mov|mkv|ogv|webm|mp3|wav|m4a|aac|ogg|oga|opus|flac|pdf|html?|excalidraw|plotly\.json)$/i;

/** Whether a target is something shown as a figure (not an embedded note). */
export function isFigureTarget(target: string): boolean {
  const t = target.trim();
  return /^https?:\/\//i.test(t) || FILE.test(t);
}

export interface MediaText {
  /** `wiki`: `![[…]]`; `image`: `![…](…)`. */
  spelling: 'wiki' | 'image';
  from: number;
  /** Where the embed itself ends, and its attributes begin. */
  end: number;
  /** Where its attributes end (`end` if it has none). */
  to: number;
  target: string;
  subpath?: string;
  /** What is written as its caption and size, with the size of the attributes. */
  alias?: string;
  /** Where that is written; empty (and after the target) where there is none. */
  aliasFrom: number;
  aliasTo: number;
  /** Where its caption is written (without a size at its end). */
  captionFrom: number;
  captionTo: number;
  caption?: string;
  size: EmbedSize;
  /** Its label: `{#fig-a}`. */
  id?: string;
}

/** The caption in an alias: everything but a size at its end (`Caption|300`). */
export function embedCaption(alias: string | undefined): string | undefined {
  if (!alias) return undefined;
  const parts = alias.split(/\\?\|/);
  if (isEmbedSize(parts[parts.length - 1]!)) parts.pop();
  return parts.join('|').trim() || undefined;
}

/** Inline code is text, whatever it looks like: blanked out, so that places stay where they are. */
const withoutCode = (line: string) =>
  line.replace(/(`+)(?!`)(.*?[^`])\1(?!`)/g, (code) => ' '.repeat(code.length));

/** Everything embedded in a line of text, in order. */
export function mediaIn(line: string): MediaText[] {
  if (!line.includes('![')) return [];
  const text = withoutCode(line);
  const found: MediaText[] = [];
  const add = (
    m: RegExpMatchArray,
    spelling: MediaText['spelling'],
    what: { target: string; subpath?: string },
    alias: string | undefined,
    aliasFrom: number,
    aliasTo: number,
  ) => {
    const end = m.index! + m[0].length;
    const attributes = parseImageAttributes(text.slice(end));
    const full = attributes?.size ? withAliasSize(alias, attributes.size) : alias;
    const caption = embedCaption(full);
    const raw = text.slice(aliasFrom, aliasTo);
    const last = /(^|\\?\|)([^|]*)$/.exec(raw);
    const sized = last && isEmbedSize(last[2]!) ? last.index : raw.length;
    found.push({
      spelling,
      from: m.index!,
      end,
      to: end + (attributes?.length ?? 0),
      target: what.target,
      ...(what.subpath ? { subpath: what.subpath } : {}),
      ...(full !== undefined ? { alias: full } : {}),
      aliasFrom,
      aliasTo,
      captionFrom: aliasFrom,
      captionTo: aliasFrom + sized,
      ...(caption ? { caption } : {}),
      size: parseEmbedSize(full),
      ...(attributes?.id ? { id: attributes.id } : {}),
    });
  };
  for (const m of text.matchAll(embedPattern())) {
    const inner = m[1]!;
    const start = m.index + 3;
    const bar = /\\?\|/.exec(inner);
    const named = bar ? inner.slice(0, bar.index) : inner;
    const web = /^\s*https?:\/\//i.test(named);
    const hash = web ? -1 : named.indexOf('#');
    const subpath = hash < 0 ? '' : named.slice(hash + 1).trim();
    const aliasFrom = start + (bar ? bar.index + bar[0].length : inner.length);
    add(
      m,
      'wiki',
      { target: (hash < 0 ? named : named.slice(0, hash)).trim(), ...(subpath ? { subpath } : {}) },
      bar ? inner.slice(bar.index + bar[0].length).trim() : undefined,
      aliasFrom,
      start + inner.length,
    );
  }
  for (const m of text.matchAll(imagePattern())) {
    const from = m.index + 2;
    add(m, 'image', imageTarget(m[2]!), m[1]!.trim() || undefined, from, from + m[1]!.length);
  }
  return found.sort((a, b) => a.from - b.from);
}

/** What is embedded exactly at `offset` of a line. Never another one: it is about to be changed. */
export function mediaAt(line: string, offset: number): MediaText | undefined {
  return mediaIn(line).find((m) => m.from === offset);
}

export interface LineChange {
  from: number;
  to: number;
  insert: string;
}

/** A share of the text (`embedShare`) in percent, without needless digits. */
const percent = (width: number) => `${+((width / TEXT_WIDTH) * 100).toFixed(1)}%`;

/**
 * Writes a size into the attributes of what is embedded: `{width=50%}`. One that is written in
 * its caption (`|300`) goes. `width` is in the note's measure (350 is half of the text), `height`
 * in pixels
 * (or as it is written, `3cm`); without a height it keeps its proportions.
 */
export function mediaSizeChanges(
  line: string,
  media: MediaText,
  size: { width: number; height?: number | string },
): LineChange[] {
  const block = line.slice(media.end, media.to);
  const rest = block
    .slice(1, -1)
    .replace(/(^|\s)(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const tall = typeof size.height === 'number' ? `${Math.round(size.height)}px` : size.height;
  const height = tall ? ` height=${tall}` : '';
  const insert = `{${rest ? `${rest} ` : ''}width=${percent(size.width)}${height}}`;
  const changes: LineChange[] = [];
  if (insert !== block) changes.push({ from: media.end, to: media.to, insert });
  // The bar (and an alias that was nothing but a size) with it.
  const alias = line.slice(media.aliasFrom, media.aliasTo);
  const last = /(^|\\?\|)([^|]*)$/.exec(alias);
  if (last && isEmbedSize(last[2]!)) {
    const whole = last.index === 0 && !last[1];
    const bar =
      whole && media.spelling === 'wiki' ? /\\?\|$/.exec(line.slice(0, media.aliasFrom)) : null;
    changes.unshift({
      from: media.aliasFrom + (whole ? -(bar?.[0].length ?? 0) : last.index),
      to: media.aliasTo,
      insert: '',
    });
  }
  return changes;
}

/** Writes the caption of what is embedded, keeping a size in it; an empty one removes it. */
export function mediaCaptionChange(line: string, media: MediaText, caption: string): LineChange {
  const alias = line.slice(media.aliasFrom, media.aliasTo);
  const parts = alias.split(/\\?\|/);
  const size = isEmbedSize(parts[parts.length - 1]!) ? parts.pop()!.trim() : undefined;
  // What would end the embed or split the caption cannot be part of it; links in it stay.
  const plain = (t: string) => t.replace(/[|[\]\n]+/g, ' ');
  let text = '';
  let at = 0;
  for (const link of caption.matchAll(/\[\[[^[\]\n]+\]\]/g)) {
    text += plain(caption.slice(at, link.index)) + link[0];
    at = link.index + link[0].length;
  }
  text = (text + plain(caption.slice(at))).replace(/\s+/g, ' ').trim();
  const bar = /\\?\|$/.exec(line.slice(0, media.aliasFrom))?.[0];
  // In a table cell the bar is written `\|`.
  const sep = media.spelling === 'wiki' && (bar ?? '').length === 2 ? '\\|' : '|';
  const written = [text, size].filter((p) => p).join(sep);
  if (media.spelling === 'image')
    return { from: media.aliasFrom, to: media.aliasTo, insert: written };
  return {
    from: media.aliasFrom - (bar?.length ?? 0),
    to: media.aliasTo,
    insert: written ? sep + written : '',
  };
}
