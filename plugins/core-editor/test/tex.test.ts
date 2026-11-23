import { describe, expect, it } from 'vitest';
import { texTokens } from '../src/tex';

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
