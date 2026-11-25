/**
 * A table of contents written into a note: a `toc` block (or a line that says `[TOC]`), shown
 * as the list of the note's headings. Nothing but the block is in the file; the list is made
 * when the note is shown.
 */

export interface TocOptions {
  /** A line above the list. */
  title?: string;
  /** How many levels of headings are listed, counted from the highest one there is. */
  depth: number;
  /** `1`, `1.1`, `1.2` in front of the entries. */
  numbered: boolean;
  /** All headings of the note, or only those below where the block stands. */
  from: 'all' | 'below';
}

export interface TocEntry {
  /** 0 for the highest level listed. */
  level: number;
  text: string;
  /** `2.1`, with `numbered`. */
  number?: string;
}

export const DEFAULT_TOC: TocOptions = { depth: 3, numbered: false, from: 'all' };

/** The settings of a `toc` block: `key: value` lines, unknown ones and empty lines left out. */
export function parseTocBlock(source: string): TocOptions {
  const options: TocOptions = { ...DEFAULT_TOC };
  for (const line of source.split('\n')) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    const yes = /^(true|yes|on|1)$/i.test(value);
    if (key === 'title' && value) options.title = value.replace(/^(["'])(.*)\1$/, '$2');
    else if (key === 'depth' && Number(value) >= 1)
      options.depth = Math.min(6, Math.floor(Number(value)));
    else if (key === 'numbered') options.numbered = yes;
    else if (key === 'from' && /^(all|below)$/i.test(value))
      options.from = value.toLowerCase() as TocOptions['from'];
  }
  return options;
}

/**
 * The entries of a table of contents. `below`: the offset in the note behind which headings
 * count (where the block stands), used with `from: below`.
 */
export function tocEntries(
  headings: ReadonlyArray<{ level: number; text: string; from: number }>,
  options: TocOptions,
  below?: number,
): TocEntry[] {
  const counted = headings.filter(
    (h) => h.text.trim() && (options.from === 'all' || below === undefined || h.from > below),
  );
  if (!counted.length) return [];
  const top = Math.min(...counted.map((h) => h.level));
  const counters: number[] = [];
  const entries: TocEntry[] = [];
  for (const h of counted) {
    const level = h.level - top;
    if (level >= options.depth) continue;
    counters.length = level + 1;
    for (let i = 0; i <= level; i++) counters[i] ??= 0;
    counters[level]!++;
    entries.push({
      level,
      text: h.text.trim(),
      // A level that was skipped (`#` then `###`) counts as its first.
      ...(options.numbered ? { number: counters.map((n) => n || 1).join('.') } : {}),
    });
  }
  return entries;
}

/** A line that is nothing but `[TOC]`: the table of contents with its defaults. */
export const TOC_LINE = /^[ \t]*\[toc\][ \t]*$/i;
