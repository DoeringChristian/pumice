import katex from 'katex';
import { describe, expect, it } from 'vitest';
import {
  compilePreamble,
  normalizePreamble,
  notePreamble,
  preambleStatements,
  preambleText,
} from '../src/preamble';

const render = (tex: string, macros: Record<string, unknown>) =>
  katex.renderToString(tex, { macros: { ...macros } as never, throwOnError: true });

describe('the LaTeX preamble', () => {
  it('makes its commands usable in formulas', () => {
    const { macros, errors } = compilePreamble(
      katex,
      '% sets\n\\newcommand{\\RR}{\\mathbb{R}}\n\\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}\n\\def\\half{\\frac{1}{2}}\n',
    );
    expect(errors).toEqual([]);
    expect(() => render('x \\in \\RR, \\norm{x} = \\half', macros)).not.toThrow();
    expect(() => render('\\RR', {})).toThrow();
  });

  it('understands \\DeclareMathOperator', () => {
    expect(normalizePreamble('\\DeclareMathOperator{\\argmax}{arg\\,max}')).toBe(
      '\\newcommand{\\argmax}{\\operatorname{arg\\,max}}',
    );
    const { macros, errors } = compilePreamble(
      katex,
      '\\DeclareMathOperator{\\tr}{tr}\n\\DeclareMathOperator*{\\argmin}{argmin}',
    );
    expect(errors).toEqual([]);
    expect(() => render('\\tr A + \\argmin_x f', macros)).not.toThrow();
  });

  it('keeps the definitions that are right when one is wrong', () => {
    const { macros, errors } = compilePreamble(
      katex,
      '\\newcommand{\\RR}{\\mathbb{R}}\n\\bad{1}\n\\newcommand{\\NN}{\\mathbb{N}}',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('\\bad');
    expect(() => render('\\RR + \\NN', macros)).not.toThrow();
  });

  it('lets a preamble redefine a command that exists already', () => {
    // KaTeX has its own \\R.
    const { macros, errors } = compilePreamble(
      katex,
      '\\newcommand{\\R}{\\mathcal{R}}\n\\renewcommand{\\fresh}{1}',
    );
    expect(errors).toEqual([]);
    expect(render('\\R', macros)).toContain('mathcal');
    expect(() => render('\\fresh', macros)).not.toThrow();
  });

  it('adds a note’s own definitions to the vault’s', () => {
    const vault = compilePreamble(katex, '\\newcommand{\\RR}{\\mathbb{R}}').macros;
    const note = compilePreamble(katex, '\\newcommand{\\x}{\\mathbf{x}}', vault).macros;
    expect(() => render('\\x \\in \\RR', note)).not.toThrow();
    // The vault's own table is not changed by the note.
    expect(() => render('\\x', vault)).toThrow();
  });

  it('splits definitions over several lines', () => {
    expect(preambleStatements('\\newcommand{\\a}{\n  1\n}\n\n\\def\\b{2} % two\n')).toEqual([
      '\\newcommand{\\a}{\n  1\n}',
      '\\def\\b{2} ',
    ]);
  });

  it('reads a note as its latex code blocks, a .tex file as it is', () => {
    const note =
      'Sets:\n\n```latex\n\\newcommand{\\R}{\\mathbb{R}}\n```\n\nand\n\n```tex\n\\def\\a{1}\n```\n\n```python\nx\n```\n';
    expect(preambleText('preamble.md', note)).toBe(
      '\\newcommand{\\R}{\\mathbb{R}}\n\n\\def\\a{1}\n',
    );
    expect(preambleText('preamble.tex', '\\def\\a{1}')).toBe('\\def\\a{1}');
  });

  it('tells TeX in a note’s property from files it names', () => {
    expect(notePreamble('\\newcommand{\\x}{\\mathbf{x}}')).toEqual({
      tex: ['\\newcommand{\\x}{\\mathbf{x}}'],
      files: [],
    });
    expect(notePreamble(['[[macros.tex]]', 'shared/physics.tex', '\\def\\a{1}'])).toEqual({
      tex: ['\\def\\a{1}'],
      files: ['macros.tex', 'shared/physics.tex'],
    });
    expect(notePreamble(undefined)).toEqual({ tex: [], files: [] });
  });
});
