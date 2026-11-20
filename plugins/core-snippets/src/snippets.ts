import { formatDate } from '@pumice/api';

/** A name that turns into text: typing `:name:` writes `text`. */
export interface Snippet {
  name: string;
  /** May contain `{{date}}`, `{{time}}`, `{{date:FORMAT}}`, and `{{cursor}}` for where to go on. */
  text: string;
  description?: string;
}

const day = (offset: number) => `{{date${offset < 0 ? '' : '+'}${offset}:YYYY-MM-DD}}`;

export const BUILT_IN: Snippet[] = [
  { name: 'today', text: '{{date:YYYY-MM-DD}}', description: 'the date' },
  { name: 'tomorrow', text: day(1), description: 'tomorrow’s date' },
  { name: 'yesterday', text: day(-1), description: 'yesterday’s date' },
  { name: 'now', text: '{{date:YYYY-MM-DD HH:mm}}', description: 'date and time' },
  { name: 'time', text: '{{date:HH:mm}}', description: 'the time' },
  { name: 'date', text: '{{date:D MMMM YYYY}}', description: 'the date, written out' },
  { name: 'weekday', text: '{{date:dddd}}', description: 'the day of the week' },
  { name: 'week', text: '{{date:YYYY-[W]ww}}', description: 'the calendar week' },
  { name: 'daily', text: '[[{{date:YYYY-MM-DD}}]]', description: 'a link to today’s note' },
];

/**
 * The user's own snippets, one per line as `name = text`. `\n` in the text is a line break;
 * lines starting with `#` are remarks.
 */
export function parseSnippets(source: string): Snippet[] {
  const out: Snippet[] = [];
  for (const line of source.split('\n')) {
    const m = /^\s*:?([A-Za-z][\w-]*):?\s*=\s?(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    out.push({ name: m[1]!, text: m[2]!.replace(/\\n/g, '\n') });
  }
  return out;
}

/** Own snippets come first, so that they can replace the built-in ones of the same name. */
export function allSnippets(own: Snippet[]): Snippet[] {
  const names = new Set(own.map((s) => s.name.toLowerCase()));
  return [...own, ...BUILT_IN.filter((s) => !names.has(s.name))];
}

/** A snippet's text with its placeholders filled in, and where the cursor goes in it. */
export function expand(text: string, now = new Date()): { text: string; cursor: number } {
  const filled = text.replace(
    /\{\{(date|time)([+-]\d+)?(?::([^}]*))?\}\}/g,
    (_, kind: string, offset: string | undefined, format: string | undefined) => {
      const at = new Date(now);
      if (offset) at.setDate(at.getDate() + Number(offset));
      return formatDate(at, format ?? (kind === 'time' ? 'HH:mm' : 'YYYY-MM-DD'));
    },
  );
  const cursor = filled.indexOf('{{cursor}}');
  return cursor < 0
    ? { text: filled, cursor: filled.length }
    : { text: filled.replace('{{cursor}}', ''), cursor };
}

/**
 * What the text before the cursor asks for, once the closing colon is typed: `… :today` + `:`.
 * A name must stand at the start of the text or after a space or bracket, so that `12:30:` or
 * a URL is left alone.
 */
export function snippetBefore(
  before: string,
  snippets: Snippet[],
): { snippet: Snippet; start: number } | undefined {
  const m = /(?:^|[\s([{>"'])(:([A-Za-z][\w-]*))$/.exec(before);
  if (!m) return undefined;
  const snippet = snippets.find((s) => s.name.toLowerCase() === m[2]!.toLowerCase());
  return snippet && { snippet, start: before.length - m[1]!.length };
}
