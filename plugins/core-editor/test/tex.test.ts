import { describe, expect, it } from 'vitest';
import { texTokens, typedInlineMath, withCaret } from '../src/tex';

const kinds = (tex: string) => texTokens(tex).map((t) => `${t.kind}:${tex.slice(t.from, t.to)}`);

describe('colouring TeX', () => {
  it('tells commands, braces, scripts and numbers apart', () => {
    expect(kinds('\\frac{a_1}{2.5} + x^2')).toEqual([
      'command:\\frac',
      'brace:{',
      'script:_',
      'number:1',
      'brace:}',
      'brace:{',
      'number:2.5',
      'brace:}',
      'script:^',
      'number:2',
    ]);
  });
  it('takes two characters for \\\\ and escaped symbols', () => {
    expect(kinds('a \\\\ \\{ b \\}')).toEqual(['command:\\\\', 'command:\\{', 'command:\\}']);
  });
  it('names the environment', () => {
    expect(kinds('\\begin{aligned} a &= b \\end{aligned}')).toEqual([
      'command:\\begin',
      'brace:{',
      'environment:aligned',
      'brace:}',
      'script:&',
      'command:\\end',
      'brace:{',
      'environment:aligned',
      'brace:}',
    ]);
  });
  it('greys a comment to the end of its line', () => {
    expect(kinds('a % note {x}\nb')).toEqual(['comment:% note {x}']);
  });
});

describe('a formula that ends in a space while it is written', () => {
  const at = (text: string) => {
    const column = text.indexOf('|');
    return typedInlineMath(text.replace('|', ''), column);
  };
  it('is still a formula with the cursor at its end', () => {
    expect(at('Energy $a + |$ here')).toEqual({ from: 7, to: 13, tex: 'a + ' });
    expect(at('$x |$')).toEqual({ from: 0, to: 4, tex: 'x ' });
    expect(at('$x|  $')).toEqual({ from: 0, to: 5, tex: 'x  ' });
  });
  it('is nothing special when it does not end in a space', () => {
    expect(at('$a + b|$')).toBeUndefined();
  });
  it('leaves prices alone', () => {
    // The cursor is not at the end of something between two dollars.
    expect(at('It costs $5 and| then $6')).toBeUndefined();
    expect(at('It costs $5. Use the |$ sign')).toEqual({ from: 9, to: 22, tex: '5. Use the ' });
    expect(at('a $ b |$')).toBeUndefined();
  });
  it('is not a $$ formula, an escaped dollar or an empty one', () => {
    expect(at('$$a |$$')).toBeUndefined();
    expect(at('\\$a |$')).toBeUndefined();
    expect(at('$ |$')).toBeUndefined();
  });
});

describe('the cursor in a formula preview', () => {
  const C = '{\\htmlClass{pm-math-caret}{\\mathstrut}}';
  const at = (text: string) => withCaret(text.replace('|', ''), text.indexOf('|'));
  it('is marked where it stands', () => {
    expect(at('a + |b')).toBe(`a + ${C}b`);
    expect(at('|a')).toBe(`${C}a`);
    expect(at('a|')).toBe(`a${C}`);
    expect(at('\\frac{a|}{b}')).toBe(`\\frac{a${C}}{b}`);
    expect(at('x^{2|}')).toBe(`x^{2${C}}`);
  });
  it('stays out of a command and what it takes', () => {
    expect(at('a + \\be|ta')).toBe(`a + ${C}\\beta`);
    expect(at('\\frac|{a}{b}')).toBe(`${C}\\frac{a}{b}`);
    expect(at('\\|alpha')).toBe(`${C}\\alpha`);
    expect(at('a \\|{ b')).toBe(`a ${C}\\{ b`);
    expect(at('\\sum|_{i} x')).toBe(`${C}\\sum_{i} x`);
    // Behind a symbol that takes nothing, it stands where it is.
    expect(at('\\alpha |')).toBe(`\\alpha ${C}`);
    expect(at('\\alpha| + 1')).toBe(`\\alpha${C} + 1`);
  });
  it('stands behind a line break', () => {
    expect(at('a \\\\|b')).toBe(`a \\\\${C}b`);
  });
});
