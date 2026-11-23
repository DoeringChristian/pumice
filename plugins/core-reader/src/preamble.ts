/**
 * The LaTeX preamble: definitions that every formula can use (`\newcommand{\R}{\mathbb{R}}`).
 * One file holds them for the whole vault; a note can add its own in its `preamble` property.
 */

/** KaTeX's table of macros: a name (`\R`) and what it stands for. */
export type Macros = Record<string, unknown>;

interface Katex {
  renderToString(tex: string, options: Record<string, unknown>): string;
}

/**
 * The TeX of a preamble file. A `.tex` file is its text; a note is the `latex`/`tex` code
 * blocks in it (so the definitions can be explained in prose around them).
 */
export function preambleText(path: string, text: string): string {
  if (!/\.(md|markdown)$/i.test(path)) return text;
  const blocks: string[] = [];
  for (const m of text.matchAll(
    /^(`{3,}|~{3,})[ \t]*(?:latex|tex|preamble)[ \t]*\n([\s\S]*?)^\1[ \t]*$/gim,
  ))
    blocks.push(m[2]!);
  return blocks.join('\n');
}

/** What KaTeX does not know as a definition, written as one it does. */
export function normalizePreamble(tex: string): string {
  return tex
    .replace(
      /\\DeclareMathOperator(\*?)\s*\{?\s*(\\[a-zA-Z]+)\s*\}?\s*\{/g,
      (_m, star: string, name: string) => `\\newcommand{${name}}{\\operatorname${star}{`,
    )
    .replace(/(\\newcommand\{\\[a-zA-Z]+\}\{\\operatorname\*?\{[^{}]*\})/g, '$1}');
}

/** The definitions of a preamble, one at a time: lines are joined until their braces close. */
export function preambleStatements(tex: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const raw of tex.split('\n')) {
    const line = raw.replace(/(^|[^\\])%.*$/, '$1');
    if (!line.trim() && depth === 0) continue;
    current += (current ? '\n' : '') + line;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') i++;
      else if (line[i] === '{') depth++;
      else if (line[i] === '}') depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      out.push(current);
      current = '';
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

/**
 * Reads a preamble into macros, on top of `base`. A definition KaTeX cannot read is left out
 * and reported; the others still count.
 */
export function compilePreamble(
  katex: Katex,
  tex: string,
  base: Macros = {},
): { macros: Macros; errors: string[] } {
  const options = (macros: Macros) => ({
    macros,
    globalGroup: true,
    throwOnError: true,
    strict: 'ignore',
    trust: true,
  });
  const source = normalizePreamble(tex);
  const all = { ...base };
  try {
    katex.renderToString(source, options(all));
    return { macros: all, errors: [] };
  } catch {
    // One of them is wrong: each on its own, keeping the ones that are right.
  }
  const macros = { ...base };
  const errors: string[] = [];
  for (const statement of preambleStatements(source)) {
    // A preamble says what a command means here: `\\newcommand` for one that exists already
    // (KaTeX has its own `\\R`) replaces it, and `\\renewcommand` for a new one defines it.
    const forms = [
      statement,
      statement.replace(/\\newcommand(?![a-zA-Z])/g, '\\renewcommand'),
      statement.replace(/\\renewcommand(?![a-zA-Z])/g, '\\newcommand'),
    ].filter((form, i, all) => all.indexOf(form) === i);
    let failure: unknown;
    let done = false;
    for (const form of forms) {
      const attempt = { ...macros };
      try {
        katex.renderToString(form, options(attempt));
        Object.assign(macros, attempt);
        done = true;
        break;
      } catch (e) {
        failure ??= e;
      }
    }
    if (done) continue;
    {
      const e = failure;
      const why = e instanceof Error ? e.message.replace(/^KaTeX parse error:\s*/, '') : String(e);
      errors.push(`${statement.trim().split('\n')[0]!.slice(0, 60)}: ${why}`);
    }
  }
  return { macros, errors };
}

/**
 * What a note's `preamble` property holds: TeX written there, and other preamble files it
 * names (`[[macros.tex]]`, `shared/macros.tex`).
 */
export function notePreamble(value: unknown): { tex: string[]; files: string[] } {
  const tex: string[] = [];
  const files: string[] = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const link = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(item.trim());
    if (link) files.push(link[1]!.trim());
    else if (/^[^\\\s{}]+\.(tex|md)$/i.test(item.trim())) files.push(item.trim());
    else tex.push(item);
  }
  return { tex, files };
}

/** Where the preambles come from, and what tells that one changed. */
export interface PreambleSources {
  /** Path of the vault's preamble file (it need not exist). */
  path(): string;
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  /** The `preamble` property of a note, as its properties hold it. */
  property(notePath: string): unknown;
  /** The file a note means by a name or link. */
  resolve(target: string, from: string): string | undefined;
  katex(): Promise<Katex>;
  /** Definitions that could not be read. */
  report(path: string, errors: string[]): void;
}

/** The macros for each note: the vault's, and the note's own on top. Compiled once. */
export class PreambleStore {
  private vault: Promise<Macros> | undefined;
  private readonly notes = new Map<string, { key: string; macros: Promise<Macros> }>();
  /** Files that were read for a preamble: a change to one of them changes the formulas. */
  private readonly files = new Set<string>();

  constructor(private readonly sources: PreambleSources) {}

  private async file(path: string, base: Macros): Promise<Macros> {
    this.files.add(path);
    if (!this.sources.exists(path)) return base;
    try {
      const tex = preambleText(path, await this.sources.read(path));
      const { macros, errors } = compilePreamble(await this.sources.katex(), tex, base);
      if (errors.length) this.sources.report(path, errors);
      return macros;
    } catch (e) {
      this.sources.report(path, [e instanceof Error ? e.message : String(e)]);
      return base;
    }
  }

  /** The macros formulas in `notePath` are drawn with (the vault's alone without a note). */
  async for(notePath?: string): Promise<Macros> {
    this.vault ??= this.file(this.sources.path(), {});
    const base = this.vault;
    if (notePath === undefined) return base;
    const value = this.sources.property(notePath);
    const key = JSON.stringify(value ?? null);
    if (key === 'null') {
      this.notes.delete(notePath);
      return base;
    }
    const known = this.notes.get(notePath);
    if (known?.key === key) return known.macros;
    const macros = (async () => {
      let all = await base;
      const { tex, files } = notePreamble(value);
      for (const target of files)
        all = await this.file(this.sources.resolve(target, notePath) ?? target, all);
      if (tex.length) {
        const own = compilePreamble(await this.sources.katex(), tex.join('\n'), all);
        if (own.errors.length) this.sources.report(notePath, own.errors);
        all = own.macros;
      }
      return all;
    })();
    this.notes.set(notePath, { key, macros });
    return macros;
  }

  /** A file changed: whether formulas have to be drawn again. */
  fileChanged(path: string): boolean {
    if (path !== this.sources.path() && !this.files.has(path)) return false;
    this.reset();
    return true;
  }

  /** A note's properties changed: whether its formulas have to be drawn again. */
  noteChanged(notePath: string): boolean {
    const known = this.notes.get(notePath);
    const key = JSON.stringify(this.sources.property(notePath) ?? null);
    if ((known?.key ?? 'null') === key) return false;
    this.notes.delete(notePath);
    return true;
  }

  reset(): void {
    this.vault = undefined;
    this.notes.clear();
    this.files.clear();
  }
}
