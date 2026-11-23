import { describe, expect, it } from 'vitest';
import { delimited, delimitedIn } from '../src/objects';

const cut = (text: string, span?: { from: number; to: number }) =>
  span ? text.slice(span.from, span.to) : undefined;

describe('text objects between marks', () => {
  it('finds a formula under or after the cursor', () => {
    const text = 'let $a+b$ and $c$ be';
    expect(cut(text, delimited(text, '$', 6, true))).toBe('a+b');
    expect(cut(text, delimited(text, '$', 6, false))).toBe('$a+b$');
    expect(cut(text, delimited(text, '$', 4, true))).toBe('a+b');
    expect(cut(text, delimited(text, '$', 8, true))).toBe('a+b');
    expect(cut(text, delimited(text, '$', 0, true))).toBe('a+b');
    expect(cut(text, delimited(text, '$', 11, true))).toBe('c');
    expect(delimited(text, '$', 18, true)).toBeUndefined();
  });
  it('takes doubled marks as one', () => {
    const text = 'a **bold *it* text** b ~~x~~ ==y==';
    expect(cut(text, delimited(text, '*', 5, true))).toBe('bold *it* text');
    expect(cut(text, delimited(text, '*', 5, false))).toBe('**bold *it* text**');
    expect(cut(text, delimited(text, '~', 25, true))).toBe('x');
    expect(cut(text, delimited(text, '=', 31, false))).toBe('==y==');
  });
  it('skips escaped marks, and takes the cells of a table', () => {
    expect(cut('a \\$5 and $x$', delimited('a \\$5 and $x$', '$', 0, true))).toBe('x');
    const row = '| one | two | three |';
    expect(cut(row, delimited(row, '|', 8, true))).toBe(' two ');
    expect(cut(row, delimited(row, '|', 14, true))).toBe(' three ');
  });
  it('finds a formula over several lines', () => {
    const doc = 'text\n$$\na = b\n+ c\n$$\nafter $x$';
    expect(cut(doc, delimitedIn(doc, '$', 10, true))).toBe('a = b\n+ c');
    expect(cut(doc, delimitedIn(doc, '$', 10, false))).toBe('$$\na = b\n+ c\n$$');
    expect(cut(doc, delimitedIn(doc, '$', 5, true))).toBe('a = b\n+ c');
    expect(cut(doc, delimitedIn(doc, '$', doc.length - 2, true))).toBe('x');
    const one = 'a $$x^2$$ b';
    expect(cut(one, delimitedIn(one, '$', 5, true))).toBe('x^2');
  });
});
