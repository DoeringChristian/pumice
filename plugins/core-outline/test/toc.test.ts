import { describe, expect, it } from 'vitest';
import { DEFAULT_TOC, TOC_LINE, parseTocBlock, tocEntries } from '../src/toc';

const headings = [
  { level: 2, text: 'Intro', from: 10 },
  { level: 3, text: 'Why', from: 40 },
  { level: 3, text: 'How', from: 80 },
  { level: 4, text: 'In detail', from: 120 },
  { level: 5, text: 'Too deep', from: 160 },
  { level: 2, text: 'Results', from: 200 },
];

describe('table of contents', () => {
  it('reads the settings of a block', () => {
    expect(parseTocBlock('')).toEqual(DEFAULT_TOC);
    expect(
      parseTocBlock('title: Contents\ndepth: 2\nnumbered: true\nfrom: below\nother: x'),
    ).toEqual({
      title: 'Contents',
      depth: 2,
      numbered: true,
      from: 'below',
    });
    expect(parseTocBlock('depth: 0\nfrom: sideways').depth).toBe(3);
    expect(parseTocBlock('from: sideways').from).toBe('all');
  });

  it('lists the headings, by levels counted from the highest there is', () => {
    expect(tocEntries(headings, DEFAULT_TOC).map((e) => `${e.level} ${e.text}`)).toEqual([
      '0 Intro',
      '1 Why',
      '1 How',
      '2 In detail',
      '0 Results',
    ]);
    expect(tocEntries(headings, { ...DEFAULT_TOC, depth: 1 }).map((e) => e.text)).toEqual([
      'Intro',
      'Results',
    ]);
    expect(tocEntries([], DEFAULT_TOC)).toEqual([]);
  });

  it('numbers them', () => {
    expect(tocEntries(headings, { ...DEFAULT_TOC, numbered: true }).map((e) => e.number)).toEqual([
      '1',
      '1.1',
      '1.2',
      '1.2.1',
      '2',
    ]);
  });

  it('lists only what is below the block, when asked', () => {
    const below = { ...DEFAULT_TOC, from: 'below' as const };
    expect(tocEntries(headings, below, 100).map((e) => `${e.level} ${e.text}`)).toEqual([
      '2 In detail',
      '0 Results',
    ]);
    expect(tocEntries(headings, DEFAULT_TOC, 100)).toHaveLength(5);
  });

  it('knows the line that stands for one', () => {
    expect(TOC_LINE.test('[TOC]')).toBe(true);
    expect(TOC_LINE.test('  [toc] ')).toBe(true);
    expect(TOC_LINE.test('see [TOC]')).toBe(false);
  });
});
