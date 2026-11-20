/**
 * Captions, numbers and labels of figures, tables and equations.
 *
 * Nothing is written into the note but what Obsidian understands too: the caption is the
 * alias of an embed (`![[plot.png|Loss over time|400]]`), the `caption:` of a frame block, or a
 * `Table: …` line above a table; the label is a block ID after it (`^fig-loss`, `^tab-runs`,
 * `^eq-energy`). Numbers are counted in the order of the note whenever it is shown.
 */

export type FigureKind = 'fig' | 'tab' | 'eq';

export interface NumberedItem {
  kind: FigureKind;
  number: number;
  /** Block ID (without `^`), if the item has one. */
  id?: string;
  caption?: string;
  /** Line the item starts on (0-based). */
  line: number;
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

const SIZE = /^\s*\d+(x\d+)?\s*$/;
const MEDIA =
  /\.(png|apng|jpe?g|jfif|gif|webp|svg|bmp|avif|ico|mp4|m4v|mov|mkv|ogv|webm|mp3|wav|m4a|aac|ogg|oga|opus|flac|pdf|html?|excalidraw)$/i;

/** The caption in an embed's alias: everything but a size at the end (`Caption|300`). */
export function embedCaption(alias: string | undefined): string | undefined {
  if (!alias) return undefined;
  const parts = alias.split(/\\?\|/);
  if (SIZE.test(parts[parts.length - 1]!)) parts.pop();
  const caption = parts.join('|').trim();
  return caption || undefined;
}

/** Whether an embed target is something shown as a figure (not an embedded note). */
export function isFigureTarget(target: string): boolean {
  return MEDIA.test(target.trim());
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
const ID_LINE = /^\s*\^([A-Za-z0-9-]+)\s*$/;
const ID_AT_END = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const TABLE_ROW = /^\s*\|?.*\|.*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const TABLE_CAPTION = /^\s*Table:\s*(.+?)\s*$/i;

/** The block ID on the line after a block (directly, or after one blank line). */
function idAfter(lines: string[], last: number): string | undefined {
  const next = ID_LINE.exec(lines[last + 1] ?? '');
  if (next) return next[1];
  if ((lines[last + 1] ?? '').trim() === '') return ID_LINE.exec(lines[last + 2] ?? '')?.[1];
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
    if (!numbered) return;
    items.push({ kind, number: ++counts[kind], ordinal, ...rest });
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
        for (let j = i + 1; j < end; j++) {
          const m = /^caption\s*:\s*(.*)$/.exec(lines[j]!);
          if (m && m[1]!.trim()) caption = unquote(m[1]!);
        }
        const id = idAfter(lines, end);
        add('fig', !!caption || labelled(id, 'fig'), {
          line: i,
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
      const id = same?.[1] ?? idAfter(lines, end);
      add('eq', labelled(id, 'eq'), { line: i, ...(labelled(id, 'eq') ? { id: id! } : {}) });
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
      const caption = above >= 0 ? TABLE_CAPTION.exec(lines[above]!)![1] : undefined;
      const id = idAfter(lines, end);
      add('tab', !!caption || labelled(id, 'tab'), {
        line: i,
        ...(caption ? { caption, captionLine: above } : {}),
        ...(labelled(id, 'tab') ? { id: id! } : {}),
      });
      i = end;
      continue;
    }

    if (!line.includes('![[')) continue;
    const id = ID_AT_END.exec(line)?.[1];
    let given = false;
    for (const m of line.matchAll(/!\[\[([^\]\n]*)\]\]/g)) {
      const inner = m[1]!;
      const bar = inner.search(/\\?\|/);
      const target = (bar < 0 ? inner : inner.slice(0, bar)).split('#')[0]!;
      if (!isFigureTarget(target)) continue;
      const caption = embedCaption(bar < 0 ? undefined : inner.slice(bar).replace(/^\\?\|/, ''));
      // The line's ID belongs to its first picture.
      const mine = !given && labelled(id, 'fig') ? id : undefined;
      given = true;
      add('fig', !!caption || !!mine, {
        line: i,
        column: m.index,
        ...(caption ? { caption } : {}),
        ...(mine ? { id: mine } : {}),
      });
    }
  }
  return items;
}
