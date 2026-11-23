/**
 * A note as slides: a line that holds only `---` starts the next slide.
 *
 * As in Markdown, `---` right under a line of text is not a separator but makes that line a
 * heading, so a separator has an empty line (or the start of the note) above it. The note's
 * properties at the top and `---` inside a code block are not separators either.
 */

export interface Slide {
  /** Where the slide's text starts and ends in the note. */
  from: number;
  to: number;
  text: string;
}

const SEPARATOR = /^ {0,3}(?:-[ \t]*){3,}$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function splitSlides(note: string): Slide[] {
  const lines = note.split('\n');
  let offset = 0;
  let start = 0;
  let first = 0;
  // The properties block is not a slide.
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
    if (end > 0) {
      first = end + 1;
      for (let i = 0; i < first; i++) offset += lines[i]!.length + 1;
      start = offset;
    }
  }
  const slides: Slide[] = [];
  const push = (from: number, to: number) => {
    const end = Math.min(to, note.length);
    const text = note.slice(from, end);
    if (text.trim()) slides.push({ from, to: end, text: text.replace(/^\n+|\s+$/g, '') });
  };
  let fence: string | undefined;
  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!;
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      // Closed by a fence of the same kind that is at least as long.
      if (
        mark &&
        mark[0] === fence[0] &&
        mark.length >= fence.length &&
        !line.slice(line.indexOf(mark) + mark.length).trim()
      )
        fence = undefined;
    } else if (mark) fence = mark;
    else if (SEPARATOR.test(line) && (i === first || !lines[i - 1]!.trim())) {
      push(start, offset);
      start = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  push(start, note.length);
  return slides;
}

/** The slide a place in the note is on (the nearest one before it, between two). */
export function slideAt(slides: Slide[], pos: number): number {
  let found = 0;
  slides.forEach((slide, i) => {
    if (slide.from <= pos) found = i;
  });
  return found;
}

/** A slide laid out in columns side by side, under what stands over all of them. */
export interface SlideColumns {
  /** A heading at the top of the slide: over the columns, not in the first one. */
  head: string;
  columns: { text: string; weight: number }[];
}

const COLUMN_BREAK = /^ {0,3}\|\|\|[ \t]*(\d+(?:[ \t]*:[ \t]*\d+)*)?[ \t]*$/;

/**
 * The columns of a slide: a line that holds only `|||` starts the next one (not in a code
 * block). `||| 2:1` gives the columns their widths, in order; without it they are equal.
 * Undefined for a slide without such a line.
 */
export function splitColumns(text: string): SlideColumns | undefined {
  const parts: string[][] = [[]];
  let weights: number[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      if (
        mark &&
        mark[0] === fence[0] &&
        mark.length >= fence.length &&
        !line.slice(line.indexOf(mark) + mark.length).trim()
      )
        fence = undefined;
    } else if (mark) fence = mark;
    else {
      const found = COLUMN_BREAK.exec(line);
      if (found) {
        if (found[1] && !weights.length) weights = found[1].split(':').map((n) => Number(n) || 1);
        parts.push([]);
        continue;
      }
    }
    parts[parts.length - 1]!.push(line);
  }
  if (parts.length < 2) return undefined;
  const columns = parts.map((lines) => lines.join('\n').replace(/^\n+|\s+$/g, ''));
  // A heading that opens the slide is the slide's, if the first column has more than it.
  let head = '';
  const first = /^(#{1,6}[ \t].*)\n+([\s\S]+)$/.exec(columns[0]!);
  if (first) {
    head = first[1]!;
    columns[0] = first[2]!;
  }
  return { head, columns: columns.map((c, i) => ({ text: c, weight: weights[i] ?? 1 })) };
}
