/**
 * Captions, numbers and labels of figures, tables and equations.
 *
 * Nothing is written into the note but what Obsidian understands too: the caption is the
 * alias of an embed (`![[plot.png|Loss over time|400]]`), the `caption:` of a frame block, or a
 * `Table: …` line above a table; the label is a block ID after it (`^fig-loss`, `^tab-runs`,
 * `^eq-energy`). Numbers are counted in the order of the note whenever it is shown.
 */

import type { TextChange } from './frontmatter';
import { ID_ALPHABET, embedPattern, isEmbedSize, parseImageAttributes } from './links';

export type FigureKind = 'fig' | 'tab' | 'eq';

export interface NumberedItem {
  kind: FigureKind;
  number: number;
  /** Block ID (without `^`), if the item has one. */
  id?: string;
  caption?: string;
  /** Line the item starts on (0-based). */
  line: number;
  /** The line it ends on (0-based): the line itself for an embed. */
  endLine: number;
  /** For an embed: where it starts in its line. */
  column?: number;
  /** For a table: the line of its `Table: …` caption. */
  captionLine?: number;
  /**
   * Position among everything of its kind in the note, numbered or not (every picture and
   * frame, every table, every `$$` block): how the rendered note is matched to this list.
   */
  ordinal: number;
}

const NAMES: Record<FigureKind, string> = { fig: 'Figure', tab: 'Table', eq: 'Equation' };

/** "Figure 2", "Table 1", "Equation 3". */
export function figureLabel(item: Pick<NumberedItem, 'kind' | 'number'>): string {
  return `${NAMES[item.kind]} ${item.number}`;
}

/** How a reference to the item reads in running text: "Figure 2", "Table 1", "(3)". */
export function figureReference(item: Pick<NumberedItem, 'kind' | 'number'>): string {
  return item.kind === 'eq' ? `(${item.number})` : figureLabel(item);
}

const MEDIA =
  /\.(png|apng|jpe?g|jfif|gif|webp|svg|bmp|avif|ico|mp4|m4v|mov|mkv|ogv|webm|mp3|wav|m4a|aac|ogg|oga|opus|flac|pdf|html?|excalidraw)$/i;

/** The caption in an embed's alias: everything but a size at the end (`Caption|300`). */
export function embedCaption(alias: string | undefined): string | undefined {
  if (!alias) return undefined;
  const parts = alias.split(/\\?\|/);
  if (isEmbedSize(parts[parts.length - 1]!)) parts.pop();
  const caption = parts.join('|').trim();
  return caption || undefined;
}

/**
 * The inside of an embed (`target#sub|alias`, without the brackets) with its caption set,
 * keeping a size at the end: `pic.png|A caption|300`. An empty caption removes it.
 */
export function setEmbedCaption(inner: string, caption: string): string {
  // In a table cell the bar is written `\|`.
  const sep = /\\\|/.test(inner) ? '\\|' : '|';
  const parts = inner.split(/\\?\|/);
  const target = parts.shift() ?? '';
  const size = parts.length && isEmbedSize(parts[parts.length - 1]!) ? parts.pop() : undefined;
  // What would end the embed or split the caption cannot be part of it; links in it stay.
  const plain = (t: string) => t.replace(/[|[\]\n]+/g, ' ');
  let text = '';
  let at = 0;
  for (const link of caption.matchAll(/\[\[[^[\]\n]+\]\]/g)) {
    text += plain(caption.slice(at, link.index)) + link[0];
    at = link.index + link[0].length;
  }
  text = (text + plain(caption.slice(at))).replace(/\s+/g, ' ').trim();
  return [target, ...(text ? [text] : []), ...(size !== undefined ? [size] : [])].join(sep);
}

/** Whether an embed target is something shown as a figure (not an embedded note). */
export function isFigureTarget(target: string): boolean {
  return MEDIA.test(target.trim());
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
const TABLE_ROW = /^\s*\|?.*\|.*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
/** `Table: A caption {#tab-runs}`: the caption (which may be missing) and the label. */
const TABLE_CAPTION = /^\s*Table:\s*(.*?)\s*(?:\{#([A-Za-z0-9-]+)\})?\s*$/i;
/** A label on a line of its own: `{#eq-energy}`, or as a block ID (`^eq-energy`). */
const ID_LINE = /^\s*(?:\^([A-Za-z0-9-]+)|\{#([A-Za-z0-9-]+)\})\s*$/;
/** The same at the end of a line. */
const ID_AT_END = /(?:(?:^|\s)\^([A-Za-z0-9-]+)|\{#([A-Za-z0-9-]+)\})\s*$/;
const idOf = (m: RegExpExecArray | null) => m?.[1] ?? m?.[2];

/** The label on the line after a block (directly, or after one blank line). */
function idAfter(lines: string[], last: number): string | undefined {
  const next = ID_LINE.exec(lines[last + 1] ?? '');
  if (next) return idOf(next);
  if ((lines[last + 1] ?? '').trim() === '') return idOf(ID_LINE.exec(lines[last + 2] ?? ''));
  return undefined;
}

const unquote = (value: string) => {
  const v = value.replace(/\s+#.*$/, '').trim();
  if (/^".*"$/.test(v)) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  return /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v;
};

/** Every numbered figure, table and equation of a note, in order. */
export function numberItems(text: string): NumberedItem[] {
  return scanItems(text, false);
}

/**
 * Every figure, table and equation of a note, also those without a number (`number` is 0):
 * what a reference can be made to, since a label gives a number to what has none.
 */
export function referableItems(text: string): NumberedItem[] {
  return scanItems(text, true);
}

function scanItems(text: string, all: boolean): NumberedItem[] {
  const lines = text.split('\n');
  const items: NumberedItem[] = [];
  const counts: Record<FigureKind, number> = { fig: 0, tab: 0, eq: 0 };
  const ordinals: Record<FigureKind, number> = { fig: 0, tab: 0, eq: 0 };
  const add = (
    kind: FigureKind,
    numbered: boolean,
    rest: Omit<NumberedItem, 'kind' | 'number' | 'ordinal'>,
  ) => {
    const ordinal = ordinals[kind]++;
    if (!numbered && !all) return;
    items.push({ kind, number: numbered ? ++counts[kind] : 0, ordinal, ...rest });
  };
  const labelled = (id: string | undefined, kind: FigureKind) =>
    id !== undefined && id.toLowerCase().startsWith(`${kind}-`);

  // Frontmatter is not content.
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      let end = i + 1;
      while (end < lines.length) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[end]!);
        if (close && close[1]![0] === fence[1]![0] && close[1]!.length >= fence[1]!.length) break;
        end++;
      }
      if (fence[2] === 'frame') {
        let caption: string | undefined;
        let own: string | undefined;
        for (let j = i + 1; j < end; j++) {
          const m = /^caption\s*:\s*(.*)$/.exec(lines[j]!);
          if (m && m[1]!.trim()) caption = unquote(m[1]!);
          const l = /^label\s*:\s*(.*)$/.exec(lines[j]!);
          // (A `label` that is no label of a figure is a setting of the frame.)
          if (l && labelled(unquote(l[1]!), 'fig')) own = unquote(l[1]!);
        }
        const id = own ?? idAfter(lines, end);
        add('fig', !!caption || labelled(id, 'fig'), {
          line: i,
          endLine: end,
          ...(caption ? { caption } : {}),
          ...(labelled(id, 'fig') ? { id: id! } : {}),
        });
      }
      i = end;
      continue;
    }

    if (/^\s*\$\$/.test(line)) {
      // One line (`$$ x $$`), or up to the line that closes it.
      let end = i;
      if (!/^\s*\$\$.*\$\$/.test(line) || /^\s*\$\$\s*$/.test(line)) {
        end = i + 1;
        while (end < lines.length && !/\$\$/.test(lines[end]!)) end++;
      }
      const same = ID_AT_END.exec(
        (lines[end] ?? '').slice((lines[end] ?? '').lastIndexOf('$$') + 2),
      );
      const id = idOf(same) ?? idAfter(lines, end);
      add('eq', labelled(id, 'eq'), {
        line: i,
        endLine: end,
        ...(labelled(id, 'eq') ? { id: id! } : {}),
      });
      i = Math.min(end, lines.length - 1);
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '') && line.includes('|')) {
      let end = i + 1;
      while (end + 1 < lines.length && lines[end + 1]!.includes('|') && lines[end + 1]!.trim())
        end++;
      const above = TABLE_CAPTION.exec(lines[i - 1] ?? '')
        ? i - 1
        : (lines[i - 1] ?? '').trim() === '' && TABLE_CAPTION.exec(lines[i - 2] ?? '')
          ? i - 2
          : -1;
      const head = above >= 0 ? TABLE_CAPTION.exec(lines[above]!)! : undefined;
      const caption = head?.[1] || undefined;
      const id = head?.[2] ?? idAfter(lines, end);
      add('tab', !!caption || labelled(id, 'tab'), {
        line: i,
        endLine: end,
        ...(caption ? { caption } : {}),
        ...(above >= 0 ? { captionLine: above } : {}),
        ...(labelled(id, 'tab') ? { id: id! } : {}),
      });
      i = end;
      continue;
    }

    if (!line.includes('![[')) continue;
    // A label behind a picture is its own (`![[a.png]]{#fig-a}`); one at the end of the line,
    // as a block ID, belongs to the first picture that has none.
    const atEnd = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line)?.[1];
    let given = false;
    for (const m of line.matchAll(embedPattern())) {
      const inner = m[1]!;
      const bar = inner.search(/\\?\|/);
      const target = (bar < 0 ? inner : inner.slice(0, bar)).split('#')[0]!;
      if (!isFigureTarget(target)) continue;
      const caption = embedCaption(bar < 0 ? undefined : inner.slice(bar).replace(/^\\?\|/, ''));
      const own = parseImageAttributes(line.slice(m.index + m[0].length))?.id;
      let mine = labelled(own, 'fig') ? own : undefined;
      if (!mine && !given && labelled(atEnd, 'fig')) {
        mine = atEnd;
        given = true;
      }
      add('fig', !!caption || !!mine, {
        line: i,
        endLine: i,
        column: m.index,
        ...(caption ? { caption } : {}),
        ...(mine ? { id: mine } : {}),
      });
    }
  }
  return items;
}

/** A label for something that has none: `fig-4k9qz`. It says nothing, so it never ages. */
export function newLabel(
  kind: FigureKind,
  text: string,
  random: () => number = Math.random,
): string {
  for (;;) {
    let id = `${kind}-`;
    for (let i = 0; i < 5; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
    if (!text.includes(id)) return id;
  }
}

/**
 * Gives an item of `text` (from `referableItems`) the label `id`: behind an embed
 * (`![[a.png]]{#fig-a}`, each picture of a line its own), in a table's caption line
 * (`Table: Runs {#tab-runs}`), on the line under a `$$` block (`{#eq-energy}`), and as the
 * `label:` of a frame block.
 */
export function labelChange(text: string, item: NumberedItem, id: string): TextChange {
  const lines = text.split('\n');
  const startOf = (index: number) => {
    let at = 0;
    for (let i = 0; i < index && i < lines.length; i++) at += lines[i]!.length + 1;
    return at;
  };
  const endOf = (index: number) => startOf(index) + (lines[index]?.length ?? 0);
  const insert = (at: number, what: string): TextChange => ({ from: at, to: at, insert: what });
  if (item.column !== undefined) {
    const line = lines[item.line] ?? '';
    const embed = embedPattern().exec(line.slice(item.column));
    const end = item.column + (embed && embed.index === 0 ? embed[0].length : 0);
    const at = startOf(item.line) + end;
    // Into the attributes that are there (`{width=50%}`), or as attributes of its own.
    return parseImageAttributes(line.slice(end))
      ? insert(at + 1, `#${id} `)
      : insert(at, `{#${id}}`);
  }
  if (item.kind === 'fig') return insert(endOf(item.line), `\nlabel: ${id}`);
  if (item.kind === 'tab')
    return item.captionLine !== undefined
      ? insert(endOf(item.captionLine), ` {#${id}}`)
      : insert(startOf(item.line), `Table: {#${id}}\n\n`);
  // An equation written on one line has it behind it.
  return insert(endOf(item.endLine), item.line === item.endLine ? ` {#${id}}` : `\n{#${id}}`);
}

/** The item a reference by number means: `fig2`, `tab-1`, `eq3` (as numbered right now). */
export function itemByNumber(items: NumberedItem[], written: string): NumberedItem | undefined {
  const m = /^(fig|tab|eq)-?(\d+)$/i.exec(written.trim());
  if (!m) return undefined;
  const kind = m[1]!.toLowerCase() as FigureKind;
  // A label that is written just like that is itself.
  if (items.some((i) => i.id === written.trim())) return undefined;
  return items.find((i) => i.kind === kind && i.number > 0 && i.number === Number(m[2]));
}

/**
 * Renames a label within a note: where it is given (`{#old}`, `label: old`, `^old`) and every link to it
 * within it (`[[#^old]]`, `[[#^old|text]]`, `@old`, also in captions).
 */
export function renameLabelChanges(text: string, old: string, id: string): TextChange[] {
  const changes: TextChange[] = [];
  const name = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of text.matchAll(new RegExp(`(^|[ \\t])\\^${name}(?=[ \\t]*$)`, 'gm'))) {
    const from = m.index + m[1]!.length + 1;
    changes.push({ from, to: from + old.length, insert: id });
  }
  for (const m of text.matchAll(new RegExp(`\\[\\[#\\^${name}(?=\\]\\]|\\\\?\\|)`, 'g'))) {
    const from = m.index + 4;
    changes.push({ from, to: from + old.length, insert: id });
  }
  // `{#old}` (also among other attributes) and the `label: old` of a frame block.
  for (const m of text.matchAll(new RegExp(`\\{[^{}\\n]*?#${name}(?=[\\s}])`, 'g'))) {
    const from = m.index + m[0].length - old.length;
    changes.push({ from, to: from + old.length, insert: id });
  }
  for (const m of text.matchAll(
    new RegExp(`^label[ \\t]*:[ \\t]*["']?${name}(?=["']?[ \\t]*$)`, 'gm'),
  )) {
    const from = m.index + m[0].length - old.length;
    changes.push({ from, to: from + old.length, insert: id });
  }
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9@])@${name}(?![A-Za-z0-9-])`, 'g'))) {
    changes.push({ from: m.index + 1, to: m.index + 1 + old.length, insert: id });
  }
  return changes.sort((a, b) => a.from - b.from);
}

/** A name that can be a label of this kind: letters, digits and hyphens after `fig-`. */
export function validLabel(kind: FigureKind, id: string): boolean {
  return new RegExp(`^${kind}-[A-Za-z0-9][A-Za-z0-9-]*$`).test(id);
}
