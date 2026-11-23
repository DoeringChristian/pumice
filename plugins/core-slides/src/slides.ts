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
