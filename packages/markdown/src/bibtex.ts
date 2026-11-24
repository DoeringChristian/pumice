/**
 * Bibliographies: reading BibTeX files, and how a citation and an entry of the reference
 * list read. Citations are written as in pandoc: `@key` in running text, `[@key, p. 3; @other]`
 * in brackets.
 */

export interface BibAuthor {
  family: string;
  given?: string;
}

export interface BibEntry {
  key: string;
  /** `article`, `inproceedings`, `book`, … (lower case). */
  type: string;
  /** The fields as written, cleaned of TeX (lower-case names). */
  fields: Record<string, string>;
  authors: BibAuthor[];
  year?: string;
  title?: string;
  /** Where it can be read: its `url`, or its DOI as one. */
  url?: string;
}

const MONTHS: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
};

const ACCENTS: Record<string, string> = {
  '"': '̈',
  "'": '́',
  '`': '̀',
  '^': '̂',
  '~': '̃',
  '=': '̄',
  '.': '̇',
  u: '̆',
  v: '̌',
  H: '̋',
  c: '̧',
  k: '̨',
  r: '̊',
};
const LETTERS: Record<string, string> = {
  ss: 'ß',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  o: 'ø',
  O: 'Ø',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
  j: 'ȷ',
};

/** A value of a BibTeX field as plain text: accents, dashes and braces of TeX resolved. */
export function texToText(value: string): string {
  return (
    value
      // `\"{o}`, `\"o`, `{\"o}`, `\c{c}`, `\v s`
      .replace(/\\(["'`^~=.])\s*\{?\\?([A-Za-z])\}?/g, (_m, a: string, l: string) =>
        (l + ACCENTS[a]!).normalize('NFC'),
      )
      .replace(/\\([uvHckr])(?:\s+|\{)\\?([A-Za-z])\}?/g, (_m, a: string, l: string) =>
        (l + ACCENTS[a]!).normalize('NFC'),
      )
      .replace(
        /\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)(?![A-Za-z])\s*/g,
        (_m, n: string) => LETTERS[n]!,
      )
      .replace(/\\([&%$#_{}])/g, '$1')
      .replace(/---/g, '—')
      .replace(/--/g, '–')
      .replace(/~/g, ' ')
      .replace(/\\(?:emph|textit|textbf|texttt|textsc|mathrm|text|url)\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\[A-Za-z]+\s*/g, '')
      .replace(/[{}]/g, '')
      .replace(/\$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** `Last, First and First von Last and {A Group}`: the authors of a field. */
export function parseAuthors(field: string): BibAuthor[] {
  const names: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && /^\s+and\s+/i.test(field.slice(i)) && /\s/.test(c!)) {
      names.push(field.slice(from, i));
      i += /^\s+and\s+/i.exec(field.slice(i))![0].length - 1;
      from = i + 1;
    }
  }
  names.push(field.slice(from));
  return names
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw): BibAuthor => {
      // A name in braces is one word: an institution.
      if (/^\{[^{}]*\}$/.test(raw)) return { family: texToText(raw) };
      const comma = raw.split(',').map((p) => texToText(p));
      if (comma.length >= 2) {
        const given = comma[comma.length - 1]!;
        return { family: comma[0]!, ...(given ? { given } : {}) };
      }
      const words = texToText(raw).split(' ');
      if (words.length === 1) return { family: words[0]! };
      // `First von Last`: the family name starts at the first lower-case word, else it is the last.
      let at = words.findIndex((w, i) => i > 0 && i < words.length - 1 && /^\p{Ll}/u.test(w));
      if (at < 0) at = words.length - 1;
      return { family: words.slice(at).join(' '), given: words.slice(0, at).join(' ') };
    });
}

/** Reads a BibTeX file. What cannot be read is left out; `@string` abbreviations are resolved. */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const strings: Record<string, string> = { ...MONTHS };
  let i = 0;
  const n = text.length;
  const space = () => {
    while (i < n && /[\s]/.test(text[i]!)) i++;
  };
  /** A value: parts joined with `#`, each in braces, in quotes, a number or an abbreviation. */
  const value = (): string => {
    let out = '';
    for (;;) {
      space();
      const c = text[i];
      if (c === '{') {
        let depth = 0;
        const from = i + 1;
        for (; i < n; i++) {
          if (text[i] === '\\') i++;
          else if (text[i] === '{') depth++;
          else if (text[i] === '}' && --depth === 0) break;
        }
        out += text.slice(from, i);
        i++;
      } else if (c === '"') {
        let depth = 0;
        const from = ++i;
        for (; i < n; i++) {
          if (text[i] === '\\') i++;
          else if (text[i] === '{') depth++;
          else if (text[i] === '}') depth--;
          else if (text[i] === '"' && depth === 0) break;
        }
        out += text.slice(from, i);
        i++;
      } else {
        const word = /^[^\s,#}){"]+/.exec(text.slice(i, i + 200))?.[0] ?? '';
        if (!word) break;
        i += word.length;
        out += /^\d+$/.test(word) ? word : (strings[word.toLowerCase()] ?? word);
      }
      space();
      if (text[i] !== '#') break;
      i++;
    }
    return out;
  };
  while (i < n) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const type = /^[A-Za-z]+/.exec(text.slice(i, i + 40))?.[0]?.toLowerCase();
    if (!type) continue;
    i += type.length;
    space();
    if (text[i] !== '{' && text[i] !== '(') continue;
    const open = text[i];
    i++;
    if (type === 'comment' || type === 'preamble') {
      // Whatever is in it, up to the brace that closes it.
      for (let depth = 1; i < n && depth > 0 && open === '{'; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
      }
      continue;
    }
    if (type === 'string') {
      space();
      const name = /^[^\s=]+/.exec(text.slice(i, i + 200))?.[0];
      if (!name) continue;
      i += name.length;
      space();
      if (text[i] !== '=') continue;
      i++;
      strings[name.toLowerCase()] = value();
      continue;
    }
    space();
    const key = /^[^\s,{}()]+/.exec(text.slice(i, i + 300))?.[0];
    if (!key) continue;
    i += key.length;
    const raw: Record<string, string> = {};
    for (;;) {
      space();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (i >= n || text[i] === '}' || text[i] === ')') {
        i++;
        break;
      }
      const name = /^[A-Za-z][\w:.+-]*/.exec(text.slice(i, i + 100))?.[0];
      if (!name) {
        // Not a field: on to the next entry.
        break;
      }
      i += name.length;
      space();
      if (text[i] !== '=') break;
      i++;
      raw[name.toLowerCase()] ??= value();
    }
    const fields: Record<string, string> = {};
    for (const [name, v] of Object.entries(raw))
      fields[name] = name === 'url' || name === 'doi' || name === 'file' ? v.trim() : texToText(v);
    const authors = parseAuthors(raw.author ?? raw.editor ?? '');
    const year = fields.year ?? /\d{4}/.exec(fields.date ?? '')?.[0];
    const doi = fields.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const url = fields.url || (doi ? `https://doi.org/${doi}` : undefined);
    entries.push({
      key,
      type,
      fields,
      authors,
      ...(year ? { year } : {}),
      ...(fields.title ? { title: fields.title } : {}),
      ...(url ? { url } : {}),
    });
  }
  return entries;
}

export type CitationStyle = 'numeric' | 'author-year';

/** Who wrote it, shortly: "Doe", "Doe and Roe", "Doe et al."; its key if nobody is named. */
export function shortAuthors(entry: BibEntry): string {
  const a = entry.authors;
  if (!a.length) return entry.fields.organization ?? entry.fields.institution ?? entry.key;
  if (a.length === 1) return a[0]!.family;
  if (a.length === 2) return `${a[0]!.family} and ${a[1]!.family}`;
  return `${a[0]!.family} et al.`;
}

/**
 * How a citation reads. `number`: its place in the note's list of references. `bracketed`: it
 * stands in brackets that are written in the text (`[@a; @b, p. 3]`), so it brings none.
 */
export function citationText(
  entry: BibEntry,
  opts: { style: CitationStyle; number: number; bracketed: boolean },
): string {
  if (opts.style === 'numeric') return opts.bracketed ? String(opts.number) : `[${opts.number}]`;
  const year = entry.year ?? 'n.d.';
  return opts.bracketed ? `${shortAuthors(entry)} ${year}` : `${shortAuthors(entry)} (${year})`;
}

const initials = (given: string) =>
  given
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((w) => `${w[0]}.`)
    .join(' ');

/** An entry of the reference list, as pieces of text; the title of what it appeared in is `em`. */
export function referenceText(entry: BibEntry): Array<{ text: string; em?: boolean }> {
  const f = entry.fields;
  const out: Array<{ text: string; em?: boolean }> = [];
  const names = entry.authors.map((a) => (a.given ? `${initials(a.given)} ${a.family}` : a.family));
  const who =
    names.length > 2
      ? `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
      : names.join(' and ');
  if (who) out.push({ text: `${who}. ` });
  if (entry.title) out.push({ text: `${entry.title.replace(/[.]$/, '')}. ` });
  const where = f.journal ?? f.journaltitle ?? f.booktitle ?? f.howpublished;
  if (where) {
    if (f.booktitle && !f.journal) out.push({ text: 'In ' });
    out.push({ text: where, em: true });
    let detail = '';
    if (f.volume) detail += ` ${f.volume}`;
    if (f.number) detail += `(${f.number})`;
    if (f.pages) detail += `${f.volume ? ':' : ', pp. '}${f.pages}`;
    out.push({ text: `${detail}. ` });
  }
  const by = f.publisher ?? f.school ?? f.institution ?? f.organization;
  if (by) out.push({ text: `${by}, ` });
  else if (entry.type === 'misc' && f.eprint)
    out.push({ text: `${f.archiveprefix ?? 'arXiv'}:${f.eprint}, ` });
  out.push({ text: `${entry.year ?? 'n.d.'}.` });
  return out;
}

/** The same as one line of text. */
export function referenceLine(entry: BibEntry): string {
  return referenceText(entry)
    .map((p) => p.text)
    .join('');
}

const CITED = /(?<![A-Za-z0-9@])@([A-Za-z0-9_][A-Za-z0-9_:.+/-]*)/g;

/** What may be a citation key behind `@`: without the punctuation of the sentence at its end. */
export function citationKey(written: string): string {
  return written.replace(/[:.+/-]+$/, '');
}

/** The keys a text cites (everything written `@key`), each once, in the order they come. */
export function citedKeys(text: string): string[] {
  const keys = new Set<string>();
  // Not what is written as code, or among the note's properties.
  const prose = text
    .replace(/^---\n[\s\S]*?\n---(?=\n|$)/, '')
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[ \t]*(?=\n|$)|$)/gm, '')
    .replace(/`[^`\n]*`/g, '');
  for (const m of prose.matchAll(CITED)) {
    const key = citationKey(m[1]!);
    if (key && !/^(?:fig|tab|eq)(?:-|\d+$)/i.test(key)) keys.add(key);
  }
  return [...keys];
}

/**
 * The references of a note in the order of its list: as they are first cited for numbers, by
 * author and year otherwise. `cited`: from `citedKeys`.
 */
export function referenceList(
  cited: string[],
  entries: ReadonlyMap<string, BibEntry>,
  style: CitationStyle,
): BibEntry[] {
  const list = cited.flatMap((key) => entries.get(key) ?? []);
  if (style === 'numeric') return list;
  return [...list].sort(
    (a, b) =>
      shortAuthors(a).localeCompare(shortAuthors(b)) ||
      (a.year ?? '').localeCompare(b.year ?? '') ||
      a.key.localeCompare(b.key),
  );
}
