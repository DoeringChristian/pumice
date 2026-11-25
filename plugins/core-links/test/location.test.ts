import { describe, expect, it } from 'vitest';
import {
  blockTarget,
  formatLocation,
  formatLocationQuote,
  formatLocationWithText,
} from '../src/location';

const text = 'line one\nline two\nline three\n';

describe('copy location', () => {
  it('formats cursor, whole lines and partial selections', () => {
    expect(formatLocation('a.md', text, 12, 12)).toBe('a.md:2');
    // "line two\n" selected as a whole line.
    expect(formatLocation('a.md', text, 9, 18)).toBe('a.md:2');
    expect(formatLocation('a.md', text, 0, 18)).toBe('a.md:1-2');
    // "two" on line 2 (cols 6-8).
    expect(formatLocation('a.md', text, 14, 17)).toBe('a.md:2:6-2:8');
    // From "one" to "line" of line 2.
    expect(formatLocation('a.md', text, 5, 13)).toBe('a.md:1:6-2:4');
    expect(formatLocation('a.md', text, 5, 13, 'at')).toBe('@a.md#L1-2');
  });

  it('adds the text in a fence that survives backticks', () => {
    const t = 'use ```js``` here\n';
    expect(formatLocationWithText('a.md', t, 0, t.length - 1)).toBe(
      'a.md:1\n````markdown\nuse ```js``` here\n````\n',
    );
    // Empty selection: the whole line.
    expect(formatLocationWithText('a.md', text, 12, 12)).toBe(
      'a.md:2\n```markdown\nline two\n```\n',
    );
  });

  it('links to headings, existing block IDs, or new block IDs at the end of the block', () => {
    const doc = '# Title\n\nFirst para\ncontinues here\n\n- item ^abc\n- other\n';
    expect(blockTarget(doc, 3, () => 'x')).toEqual({ kind: 'heading', heading: 'Title' });
    expect(blockTarget(doc, 12, () => 'new1')).toEqual({
      kind: 'block',
      id: 'new1',
      insert: { at: doc.indexOf('here') + 4, text: ' ^new1' },
    });
    expect(blockTarget(doc, doc.indexOf('item'), () => 'x')).toEqual({ kind: 'block', id: 'abc' });
    expect(blockTarget(doc, doc.indexOf('other'), () => 'n')).toEqual({
      kind: 'block',
      id: 'n',
      insert: { at: doc.indexOf('other') + 5, text: ' ^n' },
    });
  });
});

describe('copy location and selection', () => {
  const text = 'first line\nsecond line here\nthird';
  it('points at where the selection begins, with what is selected in quotes', () => {
    const from = text.indexOf('line here');
    expect(formatLocationQuote('Notes/a.md', text, from, from + 9)).toBe(
      'Notes/a.md:2:8 "line here"',
    );
  });
  it('keeps a selection over several lines as it is, without the line break at its end', () => {
    expect(formatLocationQuote('a.md', text, 6, text.indexOf('third'))).toBe(
      'a.md:1:7 "line\nsecond line here"',
    );
  });
  it('gives the place alone when nothing is selected', () => {
    expect(formatLocationQuote('a.md', text, 11, 11)).toBe('a.md:2:1');
  });
});
