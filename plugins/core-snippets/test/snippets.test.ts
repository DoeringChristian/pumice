import { describe, expect, it } from 'vitest';
import { allSnippets, expand, parseSnippets, snippetBefore } from '../src/snippets';

const now = new Date(2026, 10, 20, 9, 5);

describe('snippets', () => {
  it('fills in dates and times', () => {
    const text = (name: string) =>
      expand(allSnippets([]).find((s) => s.name === name)!.text, now).text;
    expect(text('today')).toBe('2026-11-20');
    expect(text('tomorrow')).toBe('2026-11-21');
    expect(text('yesterday')).toBe('2026-11-19');
    expect(text('now')).toBe('2026-11-20 09:05');
    expect(text('time')).toBe('09:05');
    expect(text('date')).toBe('20 November 2026');
    expect(text('daily')).toBe('[[2026-11-20]]');
  });

  it('crosses the end of a month', () => {
    expect(expand('{{date+12}}', now).text).toBe('2026-12-02');
  });

  it('puts the cursor where the snippet says', () => {
    expect(expand('## Meeting {{date}}\n\n- {{cursor}} (notes)', now)).toEqual({
      text: '## Meeting 2026-11-20\n\n-  (notes)',
      cursor: 25,
    });
    expect(expand('plain').cursor).toBe(5);
  });

  it("reads the user's own, which win over built-in ones", () => {
    const own = parseSnippets(
      '# mine\nsig = Best,\\nChris\n:today: = {{date:D.M.YYYY}}\nnot a snippet',
    );
    expect(own).toEqual([
      { name: 'sig', text: 'Best,\nChris' },
      { name: 'today', text: '{{date:D.M.YYYY}}' },
    ]);
    const all = allSnippets(own);
    expect(expand(all.find((s) => s.name === 'today')!.text, now).text).toBe('20.11.2026');
    expect(all.filter((s) => s.name === 'today')).toHaveLength(1);
  });

  it('finds the name before the closing colon', () => {
    const all = allSnippets([]);
    expect(snippetBefore('Due :today', all)).toMatchObject({
      start: 4,
      snippet: { name: 'today' },
    });
    expect(snippetBefore(':now', all)?.start).toBe(0);
    expect(snippetBefore('(:time', all)?.start).toBe(1);
    // Not a snippet: an unknown name, a time, a word with a colon inside.
    expect(snippetBefore('see :nothing', all)).toBeUndefined();
    expect(snippetBefore('at 12:30', all)).toBeUndefined();
    expect(snippetBefore('http:today', all)).toBeUndefined();
  });
});
