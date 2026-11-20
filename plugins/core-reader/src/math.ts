/**
 * Rendering TeX so that it stays useful while it is being written:
 *
 *  - every symbol of the picture knows where it comes from in the source, so a click on the
 *    formula can put the cursor there (`instrumentTex`);
 *  - a formula with a mistake still shows everything that is right, with the wrong part in
 *    red (`renderTex`).
 */

/** Commands whose argument is not math (text, names, lengths): left as written. */
const VERBATIM_ARGS: Record<string, number> = {
  text: 1,
  textbf: 1,
  textit: 1,
  textrm: 1,
  textsf: 1,
  texttt: 1,
  textnormal: 1,
  mbox: 1,
  hbox: 1,
  operatorname: 1,
  'operatorname*': 1,
  begin: 1,
  end: 1,
  label: 1,
  tag: 1,
  'tag*': 1,
  ref: 1,
  eqref: 1,
  color: 1,
  textcolor: 1,
  colorbox: 1,
  hspace: 1,
  'hspace*': 1,
  vspace: 1,
  rule: 2,
  raisebox: 1,
  href: 1,
  url: 1,
  htmlData: 1,
  htmlClass: 1,
  htmlId: 1,
  htmlStyle: 1,
  includegraphics: 1,
  char: 0,
  unicode: 1,
};
/** Commands followed by a bare length (`\kern1em`). */
const LENGTH_COMMANDS = new Set(['kern', 'mkern', 'mskip', 'hskip']);
/** Environments whose first argument is a column layout. */
const LAYOUT_ENVIRONMENTS = /^(array|darray|subarray|alignedat|alignat\*?|tabular)$/;
/** Commands that stand for one symbol. */
const SYMBOLS = new Set(
  (
    'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi ' +
    'pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta ' +
    'Lambda Xi Pi Sigma Upsilon Phi Psi Omega infty partial nabla ell hbar emptyset varnothing ' +
    'forall exists aleph imath jmath Re Im wp top bot angle'
  ).split(' '),
);
const OPERATORS = new Set('+-=<>*/,;:!|()'.split(''));

/** The text of a `{…}` group starting at `i` (which is the brace), with its braces. */
function group(tex: string, i: number): string {
  let depth = 0;
  for (let j = i; j < tex.length; j++) {
    if (tex[j] === '\\') j++;
    else if (tex[j] === '{') depth++;
    else if (tex[j] === '}' && --depth === 0) return tex.slice(i, j + 1);
  }
  return tex.slice(i);
}

/**
 * The same formula with every symbol wrapped so that the rendered picture carries its place in
 * the source (`data-p`, an offset into `tex`).
 */
export function instrumentTex(tex: string): string {
  let out = '';
  // The next symbol is the argument of a command or of `^`/`_`: it needs braces around it, and
  // a delimiter (after `\left`) must stay as it is.
  let argument = false;
  let raw = false;
  const mark = (at: number, symbol: string, braces: boolean) => {
    const wrapped = `\\htmlData{p=${at}}{${symbol}}`;
    out += braces ? `{${wrapped}}` : wrapped;
  };
  for (let i = 0; i < tex.length;) {
    const c = tex[i]!;
    if (c === '%') {
      const end = tex.indexOf('\n', i);
      out += tex.slice(i, end < 0 ? tex.length : end);
      i = end < 0 ? tex.length : end;
      continue;
    }
    if (c === '\\') {
      const name = /^[a-zA-Z]+\*?/.exec(tex.slice(i + 1))?.[0];
      if (!name) {
        // `\\`, `\{`, `\,` …; a line break may carry a length: `\\[2pt]`.
        out += tex.slice(i, i + 2);
        i += 2;
        if (tex[i - 1] === '\\') {
          const gap = /^\s*\[[^\]]*\]/.exec(tex.slice(i));
          if (gap) {
            out += gap[0];
            i += gap[0].length;
          }
        }
        argument = raw = false;
        continue;
      }
      const at = i;
      i += 1 + name.length;
      if (SYMBOLS.has(name)) {
        if (raw) out += `\\${name}`;
        else mark(at, `\\${name}`, true);
        argument = raw = false;
        continue;
      }
      out += `\\${name}`;
      if (LENGTH_COMMANDS.has(name)) {
        const length = /^\s*-?[\d.]+\s*[a-z]{2}/.exec(tex.slice(i));
        if (length) {
          out += length[0];
          i += length[0].length;
        }
        continue;
      }
      let verbatim = VERBATIM_ARGS[name] ?? 0;
      let environment: string | undefined;
      while (verbatim > 0) {
        const space = /^\s*/.exec(tex.slice(i))![0];
        if (tex[i + space.length] !== '{') break;
        const g = group(tex, i + space.length);
        out += space + g;
        i += space.length + g.length;
        if (name === 'begin') environment = g.slice(1, -1);
        verbatim--;
      }
      if (environment && LAYOUT_ENVIRONMENTS.test(environment)) {
        const layout = /^\s*(\[[^\]]*\])?\s*/.exec(tex.slice(i))![0];
        out += layout;
        i += layout.length;
        if (tex[i] === '{') {
          const g = group(tex, i);
          out += g;
          i += g.length;
        }
      }
      // What follows may be this command's argument (`\frac12`) or delimiter (`\left(`).
      argument = true;
      raw = /^(left|right|middle|big|Big|bigg|Bigg)[lrm]?$/.test(name);
      continue;
    }
    if (/\s/.test(c)) {
      out += c;
      i++;
      continue;
    }
    if (/[a-zA-Z0-9]/.test(c)) {
      if (raw) out += c;
      else mark(i, c, true);
      i++;
      argument = raw = false;
      continue;
    }
    if (OPERATORS.has(c) && !argument && !raw) mark(i, c, false);
    else out += c;
    i++;
    argument = c === '^' || c === '_';
    raw = false;
  }
  return out;
}

/** A piece of TeX that was cut off, closed so that it can be drawn: `\frac{a}{` → `\frac{a}{}`. */
export function closeOpenGroups(prefix: string): string {
  let out = prefix.replace(/\\[a-zA-Z]*$/, '').replace(/[\^_]\s*$/, '');
  const environments: string[] = [];
  let braces = 0;
  let lefts = 0;
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (c === '\\') {
      const rest = out.slice(i + 1);
      const begin = /^begin\{([^}]*)\}/.exec(rest);
      const end = /^end\{([^}]*)\}/.exec(rest);
      if (begin) environments.push(begin[1]!);
      else if (end) environments.pop();
      else if (/^left(?![a-zA-Z])/.test(rest)) lefts++;
      else if (/^right(?![a-zA-Z])/.test(rest)) lefts = Math.max(0, lefts - 1);
      i++;
    } else if (c === '{') braces++;
    else if (c === '}') braces = Math.max(0, braces - 1);
  }
  out += '}'.repeat(braces);
  out += '\\right.'.repeat(lefts);
  while (environments.length) out += `\\end{${environments.pop()}}`;
  return out;
}

/** Source shown as it is, in red, inside a formula. */
function asWrong(source: string): string {
  const text = source
    .replace(/\\/g, '\\textbackslash ')
    .replace(/([{}$%#&_])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum ')
    .replace(/~/g, '\\textasciitilde ');
  return `\\textcolor{#d03a3a}{\\texttt{${text}}}`;
}

interface Katex {
  render(tex: string, element: HTMLElement, options: Record<string, unknown>): void;
}

const OPTIONS = {
  output: 'htmlAndMathml',
  throwOnError: true,
  // `\htmlData` carries the source positions.
  trust: true,
  strict: 'ignore',
};

/**
 * Draws `tex` into `container`. Returns what is wrong with it (undefined if nothing): a
 * formula with mistakes is drawn as far as it is right, the wrong parts in red.
 */
export function renderTex(
  katex: Katex,
  tex: string,
  display: boolean,
  container: HTMLElement,
): string | undefined {
  const options = { ...OPTIONS, displayMode: display };
  const draw = (source: string) => katex.render(source, container, options);
  try {
    try {
      draw(instrumentTex(tex));
    } catch {
      // The wrapping did not agree with this formula: draw it plainly (no click positions).
      draw(tex);
    }
    return undefined;
  } catch (first) {
    const message =
      first instanceof Error ? first.message.replace(/^KaTeX parse error:\s*/, '') : String(first);
    // Mark what the parser stumbles over and go on with the rest, a few times.
    let source = tex;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        draw(source);
        return message;
      } catch (e) {
        const at = (e as { position?: number }).position;
        const length = (e as { length?: number }).length;
        if (typeof at !== 'number' || !length || at + length > source.length) break;
        source =
          source.slice(0, at) + asWrong(source.slice(at, at + length)) + source.slice(at + length);
      }
    }
    // Something is unfinished (a brace, an environment): what stands before it, closed.
    const at = (first as { position?: number }).position ?? tex.length;
    for (let cut = Math.min(at, tex.length), tries = 0; cut >= 0 && tries < 12; tries++) {
      try {
        const rest = tex.slice(cut).trim();
        draw(closeOpenGroups(tex.slice(0, cut)) + (rest ? `\;${asWrong(rest)}` : ''));
        return message;
      } catch {
        // Back to before the last word or command.
        const before = tex.slice(0, cut).search(/(\\[a-zA-Z]*|\S+|\s+)$/);
        cut = before >= 0 && before < cut ? before : cut - 1;
      }
    }
    container.textContent = tex;
    container.classList.add('pm-math-error');
    return message;
  }
}
