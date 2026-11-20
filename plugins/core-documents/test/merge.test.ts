import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyTextDiff, merge3 } from '../src';

describe('merge3', () => {
  it('takes the only changed side', () => {
    expect(merge3('a\nb\n', 'a\nb\n', 'a\nB\n')).toEqual({ text: 'a\nB\n', clean: true });
    expect(merge3('a\nb\n', 'A\nb\n', 'a\nb\n')).toEqual({ text: 'A\nb\n', clean: true });
  });

  it('merges changes on different lines', () => {
    expect(merge3('1\n2\n3\n', 'one\n2\n3\n', '1\n2\nthree\n').text).toBe('one\n2\nthree\n');
  });

  it('merges changes in different parts of the same line', () => {
    const r = merge3('the quick brown fox\n', 'the slow brown fox\n', 'the quick brown cat\n');
    expect(r).toEqual({ text: 'the slow brown cat\n', clean: true });
  });

  it('keeps both insertions at the same position', () => {
    expect(merge3('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n').text).toBe('a\nX\nY\nb\n');
  });

  it('treats edits to adjacent lines as a conflict (like git)', () => {
    expect(merge3('a\nb\n', 'a\nb!\n', 'A\nb\n').clean).toBe(false);
  });

  it('reports true conflicts and keeps ours', () => {
    expect(merge3('value: 1\n', 'value: 2\n', 'value: 3\n')).toEqual({
      text: 'value: 2\n',
      clean: false,
    });
  });

  it('handles missing trailing newlines', () => {
    expect(merge3('a\nx\nb', 'a\nx\nb!', 'A\nx\nb').text).toBe('A\nx\nb!');
  });
});

describe('applyTextDiff', () => {
  it('produces the target with minimal edits', () => {
    const doc = new Y.Doc();
    const text = doc.getText('t');
    text.insert(0, 'hello world');
    const ops: unknown[] = [];
    text.observe((e) => ops.push(...e.delta));
    applyTextDiff(text, 'hello brave world');
    expect(text.toString()).toBe('hello brave world');
    expect(ops).toEqual([{ retain: 6 }, { insert: 'brave ' }]);
  });

  it('handles emoji (surrogate pairs)', () => {
    const doc = new Y.Doc();
    const text = doc.getText('t');
    text.insert(0, 'a 😀 b');
    applyTextDiff(text, 'a 😃 b 🎉');
    expect(text.toString()).toBe('a 😃 b 🎉');
  });
});
