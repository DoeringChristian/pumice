import { StreamLanguage, type StreamParser } from '@codemirror/language';

/**
 * Colours for BibTeX files: the kind of an entry (`@article`), its key, the names of its
 * fields, their values (in braces or quotes, with braces nested in them), numbers, the
 * abbreviations that stand without quotes (`jan`), and what is outside of every entry, which
 * BibTeX takes for a comment.
 */
interface BibState {
  /** Within an entry (after its opening brace). */
  entry: boolean;
  /** The next word is the key of the entry. */
  key: boolean;
  /** How deep in the braces of a value; 0: not in one. */
  braces: number;
  /** Within a value in quotes (braces in it are counted in `braces`). */
  quoted: boolean;
}

const bibtexParser: StreamParser<BibState> = {
  name: 'bibtex',
  startState: () => ({ entry: false, key: false, braces: 0, quoted: false }),
  token(stream, state) {
    if (state.quoted) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '\\') stream.next();
        else if (ch === '{') state.braces++;
        else if (ch === '}') state.braces = Math.max(0, state.braces - 1);
        else if (ch === '"' && !state.braces) {
          state.quoted = false;
          break;
        }
      }
      return 'string';
    }
    if (state.braces) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '\\') stream.next();
        else if (ch === '{') state.braces++;
        else if (ch === '}' && --state.braces === 0) break;
      }
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (!state.entry) {
      if (stream.match(/^@[A-Za-z]+/)) {
        // `@comment{…}` aside, what follows is an entry.
        return 'keyword';
      }
      if (stream.eat(/[{(]/)) {
        state.entry = true;
        state.key = true;
        return 'bracket';
      }
      // Between entries: a comment, with or without a `%`.
      if (!stream.match(/^[^@]+/)) stream.next();
      return 'comment';
    }
    if (stream.eat(/[})]/)) {
      state.entry = false;
      state.key = false;
      return 'bracket';
    }
    if (stream.eat('%')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (state.key) {
      state.key = false;
      // `@string{name = "…"}` has a name where other entries have their key.
      if (stream.match(/^[^\s,={}]+(?=\s*=)/)) return 'propertyName';
      // The key stands out: it is what a note cites.
      if (stream.match(/^[^\s,{}]+/)) return 'strong';
    }
    if (stream.eat('{')) {
      state.braces = 1;
      return 'string';
    }
    if (stream.eat('"')) {
      state.quoted = true;
      return 'string';
    }
    if (stream.match(/^\d+/)) return 'number';
    if (stream.match(/^[A-Za-z_][\w:.+-]*(?=\s*=)/)) return 'propertyName';
    if (stream.match(/^[A-Za-z_][\w:.+-]*/)) return 'atom';
    if (stream.eat(/[=#]/)) return 'operator';
    if (stream.eat(',')) return 'punctuation';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '%' }, closeBrackets: { brackets: ['{', '"'] } },
};

export const bibtexLanguage = StreamLanguage.define(bibtexParser);

export const isBibtexPath = (path: string) => /\.bib(tex)?$/i.test(path);
