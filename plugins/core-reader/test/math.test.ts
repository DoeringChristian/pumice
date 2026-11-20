import katex from 'katex';
import { describe, expect, it } from 'vitest';
import { closeOpenGroups, instrumentTex, renderTex } from '../src/math';

const html = (tex: string) =>
  katex.renderToString(tex, { trust: true, strict: 'ignore', output: 'html' });
/** The source offsets the rendered symbols carry, with the symbol at each. */
const positions = (tex: string) =>
  [...html(instrumentTex(tex)).matchAll(/data-p="(\d+)"/g)].map((m) => tex[Number(m[1])]).join('');

describe('instrumentTex', () => {
  it('marks every symbol with its place in the source', () => {
    expect(positions('a+b=c')).toBe('a+b=c');
    expect(positions('x^2 + y_i')).toBe('x2+yi');
    // A fraction is drawn from the bottom up: the order differs, the places are right.
    expect([...positions('\\frac{a}{b}')].sort().join('')).toBe('ab');
    expect([...positions('\\frac12')].sort().join('')).toBe('12');
    expect(positions('\\alpha + \\beta')).toBe('\\+\\');
  });

  it('draws the same picture as the plain formula', () => {
    const text = (s: string) => s.replace(/<[^>]+>/g, '');
    for (const tex of [
      'a+b=c',
      'E = mc^2',
      '\\frac{\\partial f}{\\partial x} = \\lim_{h \\to 0} \\frac{f(x+h)-f(x)}{h}',
      '\\left( \\sum_{i=1}^{n} x_i \\right)^2',
      '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
      '\\begin{array}{cc} a & b \\\\[2pt] c & d \\end{array}',
      '\\text{if } x > 0 \\quad \\mathbb{R}^n',
      '\\operatorname{argmin}_x f(x) \\kern1em y',
      '\\sqrt[3]{x} \\cdot \\vec{v} \\times \\hat{n}',
      '\\textcolor{red}{a} + \\hspace{1em} b',
    ]) {
      expect(text(html(instrumentTex(tex))), tex).toBe(text(html(tex)));
    }
  });

  it('keeps the spacing around operators', () => {
    const spaces = (s: string) => (s.match(/class="mspace"/g) ?? []).length;
    expect(spaces(html(instrumentTex('a+b=c')))).toBe(spaces(html('a+b=c')));
  });
});

describe('closeOpenGroups', () => {
  it('closes what was left open', () => {
    expect(closeOpenGroups('\\frac{a}{b')).toBe('\\frac{a}{b}');
    expect(closeOpenGroups('\\left( x + ')).toBe('\\left( x + \\right.');
    expect(closeOpenGroups('\\begin{pmatrix} a & b')).toBe('\\begin{pmatrix} a & b\\end{pmatrix}');
    expect(closeOpenGroups('x^')).toBe('x');
    expect(closeOpenGroups('a + \\al')).toBe('a + ');
  });
});

describe('renderTex', () => {
  const draw = (tex: string) => {
    let out = '';
    const container = {
      set innerHTML(v: string) {
        out = v;
      },
      get innerHTML() {
        return out;
      },
      classList: { add() {} },
      textContent: '',
    } as unknown as HTMLElement;
    const fake = {
      render(source: string, el: HTMLElement, options: Record<string, unknown>) {
        el.innerHTML = katex.renderToString(source, options);
      },
    };
    const problem = renderTex(fake, tex, false, container);
    return {
      problem,
      text: out.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, ''),
    };
  };

  it('draws a correct formula and reports nothing', () => {
    expect(draw('a+b').problem).toBeUndefined();
  });

  it('marks an unknown command and draws the rest', () => {
    const { problem, text } = draw('a + \\notacommand + b');
    expect(problem).toMatch(/notacommand/);
    expect(text).toContain('a');
    expect(text).toContain('b');
    expect(text).toContain('notacommand');
  });

  it('draws what is there of an unfinished formula', () => {
    const { problem, text } = draw('\\frac{a}{b} + \\frac{c}{');
    expect(problem).toBeTruthy();
    expect(text).toContain('a');
    expect(text).toContain('b');
  });
});
