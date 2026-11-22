import {
  autocompletion,
  snippetCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { editorCompletions } from '@pumice/api';

/**
 * Suggestions and automatic closing while typing: the editor asks the sources plugins
 * contributed (links, frames, …) and its own, for code blocks and math.
 */

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Whether the fence on line `index` opens a block that has no closing fence yet: the fences
 * above it pair up (so it is not itself a closing one), and so do the ones below.
 */
export function fenceIsOpen(lines: string[], index: number): boolean {
  const mark = FENCE.exec(lines[index] ?? '')?.[1];
  if (!mark) return false;
  const count = (from: number, to: number) => {
    let n = 0;
    for (let i = from; i < to; i++) {
      const other = FENCE.exec(lines[i]!)?.[1];
      if (other && other[0] === mark[0]) n++;
    }
    return n;
  };
  return count(0, index) % 2 === 0 && count(index + 1, lines.length) % 2 === 0;
}

/** The lines around line `number` (enough to pair fences up), and its index among them. */
const linesAround = (state: EditorState, number: number) => {
  const first = Math.max(1, number - 3000);
  const last = Math.min(state.doc.lines, number + 3000);
  const lines: string[] = [];
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n).text);
  return { lines, index: number - first };
};
const fenceOpenAt = (state: EditorState, number: number) => {
  const { lines, index } = linesAround(state, number);
  return fenceIsOpen(lines, index);
};

const LANGUAGES: Array<[string, string]> = [
  ['frame', 'an HTML frame with settings'],
  ['mermaid', 'a diagram'],
  ['python', ''],
  ['ts', 'TypeScript'],
  ['js', 'JavaScript'],
  ['bash', ''],
  ['json', ''],
  ['yaml', ''],
  ['cpp', 'C++'],
  ['c', ''],
  ['rust', ''],
  ['go', ''],
  ['java', ''],
  ['html', ''],
  ['css', ''],
  ['sql', ''],
  ['latex', ''],
  ['diff', ''],
  ['text', 'no highlighting'],
];

/** After ``` at the start of a line: the language, and the closing fence with it. */
function fenceSource(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/^\s*(`{3,}|~{3,})[\w+-]*$/);
  if (!before) return null;
  const mark = FENCE.exec(before.text)![1]!;
  const from = before.from + before.text.indexOf(mark) + mark.length;
  const indent = /^\s*/.exec(before.text)![0];
  const options: Completion[] = LANGUAGES.map(([lang, detail], i) => ({
    label: lang,
    detail,
    boost: -i,
    apply: (view: EditorView, _c: Completion, start: number, end: number) => {
      const line = view.state.doc.lineAt(start);
      const open = fenceOpenAt(view.state, line.number);
      // A frame block starts with the file it shows.
      const body = lang === 'frame' ? `${indent}file: ` : indent;
      const insert = open ? `${lang}\n${body}\n${indent}${mark}` : lang;
      view.dispatch({
        changes: { from: start, to: Math.max(end, line.to), insert },
        selection: { anchor: start + (open ? lang.length + 1 + body.length : lang.length) },
        userEvent: 'input.complete',
      });
      if (lang === 'frame' && open) startCompletion(view);
    },
  }));
  return { from, options, validFor: /^[\w+-]*$/ };
}

const inMath = (state: EditorState, pos: number) => {
  for (let node = syntaxTree(state).resolveInner(pos, -1); ;) {
    if (/^(InlineMath|InlineMathDisplay|MathBlock)$/.test(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
};

const plain = (names: string) => names.split(' ').map((n) => ({ label: `\\${n}` }));
const MATH: Completion[] = [
  snippetCompletion('\\frac{${num}}{${den}}', { label: '\\frac', detail: 'fraction' }),
  snippetCompletion('\\sqrt{${x}}', { label: '\\sqrt' }),
  snippetCompletion('\\sum_{${i}}^{${n}}', { label: '\\sum', detail: 'with limits' }),
  snippetCompletion('\\prod_{${i}}^{${n}}', { label: '\\prod', detail: 'with limits' }),
  snippetCompletion('\\int_{${a}}^{${b}}', { label: '\\int', detail: 'with limits' }),
  snippetCompletion('\\lim_{${x} \\to ${a}}', { label: '\\lim' }),
  snippetCompletion('\\left(${x}\\right)', { label: '\\left(', detail: '( … )' }),
  snippetCompletion('\\left[${x}\\right]', { label: '\\left[', detail: '[ … ]' }),
  snippetCompletion('\\left\\{${x}\\right\\}', { label: '\\left\\{', detail: '{ … }' }),
  snippetCompletion('\\left|${x}\\right|', { label: '\\left|', detail: '| … |' }),
  ...['mathbf', 'mathrm', 'mathcal', 'mathbb', 'mathit', 'boldsymbol', 'text', 'operatorname'].map(
    (n) => snippetCompletion(`\\${n}{\${x}}`, { label: `\\${n}` }),
  ),
  ...['hat', 'bar', 'vec', 'tilde', 'dot', 'ddot', 'overline', 'underline', 'widehat'].map((n) =>
    snippetCompletion(`\\${n}{\${x}}`, { label: `\\${n}` }),
  ),
  snippetCompletion('\\begin{${env}}\n\t${}\n\\end{${env}}', {
    label: '\\begin',
    detail: 'environment',
  }),
  ...plain(
    'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega',
  ),
  ...plain(
    'cdot times div pm mp leq geq neq approx equiv sim propto infty partial nabla in notin subset subseteq cup cap setminus emptyset forall exists to mapsto rightarrow leftarrow Rightarrow Leftarrow Leftrightarrow iff implies ldots cdots vdots ddots quad qquad langle rangle lVert rVert mid parallel perp angle circ otimes oplus dagger top ell hbar Re Im',
  ),
  ...plain('sin cos tan log ln exp min max arg sup inf det dim ker lim argmin argmax'),
];
const ENVIRONMENTS = [
  'aligned',
  'align',
  'cases',
  'matrix',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'array',
  'gathered',
  'split',
].map((env) =>
  snippetCompletion(`\\begin{${env}}\n\t\${}\n\\end{${env}}`, { label: `\\begin{${env}}` }),
);

/** Inside math: commands after a backslash, environments after `\begin{`. */
function mathSource(context: CompletionContext): CompletionResult | null {
  if (!inMath(context.state, context.pos)) return null;
  const begin = context.matchBefore(/\\begin\{[a-zA-Z*]*$/);
  if (begin) {
    // Swallow the brace closed automatically.
    const closed = context.state.doc.sliceString(context.pos, context.pos + 1) === '}';
    return { from: begin.from, to: context.pos + (closed ? 1 : 0), options: ENVIRONMENTS };
  }
  const command = context.matchBefore(/\\[a-zA-Z]*$/);
  if (!command || (command.text.length < 2 && !context.explicit)) return null;
  return { from: command.from, options: MATH, validFor: /^\\[a-zA-Z]*$/ };
}

/** Enter after an opening ``` or `$$`: the block is closed, the cursor stays inside. */
const closeBlockOnEnter = Prec.high(
  keymap.of([
    {
      key: 'Enter',
      run(view) {
        const { state } = view;
        const sel = state.selection.main;
        if (!sel.empty || state.readOnly) return false;
        const line = state.doc.lineAt(sel.head);
        const before = line.text.slice(0, sel.head - line.from);
        const lead = /^\s*/.exec(line.text)![0];
        // Between the `$$` and the `$$` closed behind it: a formula block is opened up.
        if (/^\s*\$\$$/.test(before) && /^\$\$\s*$/.test(line.text.slice(before.length))) {
          view.dispatch({
            changes: { from: sel.head, to: line.to, insert: `\n${lead}\n${lead}$$` },
            selection: { anchor: sel.head + 1 + lead.length },
            userEvent: 'input',
            scrollIntoView: true,
          });
          return true;
        }
        // At the end of the line; a backtick closed automatically behind the cursor is in the way.
        if (!/^`*$/.test(line.text.slice(sel.head - line.from))) return false;
        const typed = line.text.slice(0, sel.head - line.from);
        const indent = /^\s*/.exec(line.text)![0];
        let closing: string | undefined;
        const fence = /^\s*(`{3,}|~{3,})[^`~]*$/.exec(typed);
        if (fence && fenceOpenAt(state, line.number)) closing = fence[1]!;
        else if (/^\s*\$\$\s*$/.test(typed) && sel.head === line.to) {
          // An opening `$$`: an odd number of them up to here.
          let count = 0;
          for (let n = Math.max(1, line.number - 2000); n <= line.number; n++)
            if (/^\s*\$\$\s*$/.test(state.doc.line(n).text)) count++;
          let below = 0;
          for (let n = line.number + 1; n <= Math.min(state.doc.lines, line.number + 2000); n++)
            if (/^\s*\$\$\s*$/.test(state.doc.line(n).text)) below++;
          if (count % 2 === 1 && below % 2 === 0) closing = '$$';
        }
        if (!closing) return false;
        view.dispatch({
          changes: { from: sel.head, to: line.to, insert: `\n${indent}\n${indent}${closing}` },
          selection: { anchor: sel.head + 1 + indent.length },
          userEvent: 'input',
          scrollIntoView: true,
        });
        return true;
      },
    },
  ]),
);

/**
 * Typing `$`. A second one right after the first gives `$$|$$` (the formula is closed from the
 * start, so nothing after it is taken for a formula while it is written), and a `$` typed in
 * front of a closing one steps over it.
 */
const dollarTyping = Prec.high(
  EditorView.inputHandler.of((view, from, to, text) => {
    const { state } = view;
    if (text !== '$' || from !== to || state.readOnly) return false;
    if (state.selection.ranges.length > 1) return false;
    const around = state.doc.sliceString(Math.max(0, from - 2), from + 2);
    const at = Math.min(2, from);
    const before = around.slice(0, at);
    const after = around.slice(at);
    if (after[0] !== '$') return false;
    // A closing `$$` typed by hand on the last line of a block that is closed already
    // (`$$`, Enter, the formula, Enter, `$$`): the one that is there is used.
    const line = state.doc.lineAt(from);
    if (line.text.trim() === '$$' && from === line.to - 1 && line.number < state.doc.lines) {
      const next = state.doc.line(line.number + 1);
      if (next.text.trim() === '$$' && inMath(state, line.from)) {
        view.dispatch({
          changes: { from: line.from, to: next.from },
          selection: { anchor: next.to - (next.from - line.from) },
          userEvent: 'input.type',
        });
        return true;
      }
    }
    const loneDollar = before.endsWith('$') && !before.endsWith('$$') && after[1] !== '$';
    if (loneDollar && !inMath(state, from)) {
      // `$|$`, just typed: a display formula, closed on both sides.
      view.dispatch({
        changes: { from, insert: '$$' },
        selection: { anchor: from + 1 },
        userEvent: 'input.type',
      });
      return true;
    }
    view.dispatch({ selection: { anchor: from + 1 }, userEvent: 'select' });
    return true;
  }),
);

/** Asks the contributed sources in order; the first with suggestions is shown. */
async function allSources(context: CompletionContext): Promise<CompletionResult | null> {
  for (const source of context.state.facet(editorCompletions)) {
    const result = await source(context);
    if (result && result.options.length) return result;
    if (context.aborted) return null;
  }
  return null;
}

export function completionExtension(): Extension {
  return [
    autocompletion({
      override: [allSources],
      icons: false,
      activateOnTyping: true,
      closeOnBlur: true,
    }),
    editorCompletions.of(fenceSource),
    editorCompletions.of(mathSource),
    closeBlockOnEnter,
    dollarTyping,
    // `$` closes like a quote: `$|$`, and typing the second one steps over it.
    EditorState.languageData.of(() => [
      { closeBrackets: { brackets: ['(', '[', '{', "'", '"', '`', '$'] } },
    ]),
  ];
}
