import { describe, expect, it } from 'vitest';
import { continuationIndent, markerStart, nextItemPrefix, renumberLists } from '../src/lists';

describe('lists', () => {
  it('continues an item where its text starts', () => {
    expect(continuationIndent('- item')).toBe('  ');
    expect(continuationIndent('- [ ] task')).toBe('  ');
    expect(continuationIndent('  * nested')).toBe('    ');
    expect(continuationIndent('1. first')).toBe('   ');
    expect(continuationIndent('10) tenth')).toBe('    ');
    expect(continuationIndent('plain text')).toBeUndefined();
    expect(continuationIndent('-not a list')).toBeUndefined();
  });

  it('starts a selection at the marker when it began right behind it', () => {
    // `- |[ ] task` and `- [ ] |task`: both mean the item from its start.
    expect(markerStart('- [ ] task', 2)).toBe(0);
    expect(markerStart('- [ ] task', 6)).toBe(0);
    expect(markerStart('- item', 2)).toBe(0);
    expect(markerStart('  - nested', 4)).toBe(2);
    expect(markerStart('1. first', 3)).toBe(0);
    // From within the text, or a line that is not an item: as it is.
    expect(markerStart('- item', 4)).toBeUndefined();
    expect(markerStart('- item', 0)).toBeUndefined();
    expect(markerStart('plain', 0)).toBeUndefined();
  });

  it('takes the dash along with a checkbox, also within one line', () => {
    // From in front of the box: the dash belongs to it.
    expect(markerStart('- [ ] task', 2, false)).toBe(0);
    expect(markerStart('  - [x] done', 4, false)).toBe(2);
    // Just the text of an item, to write it anew: as it is.
    expect(markerStart('- [ ] task', 6, false)).toBeUndefined();
    expect(markerStart('- item', 2, false)).toBeUndefined();
  });

  it('starts the next item like the one before', () => {
    expect(nextItemPrefix('- item')).toBe('- ');
    expect(nextItemPrefix('- [x] done')).toBe('- [ ] ');
    expect(nextItemPrefix('  * nested')).toBe('  * ');
    expect(nextItemPrefix('3. third')).toBe('4. ');
    expect(nextItemPrefix('9) ninth')).toBe('10) ');
    expect(nextItemPrefix('text')).toBeUndefined();
  });
});

describe('numbered lists stay in order', () => {
  const fix = (text: string, first = 0, last = Infinity): string => {
    const lines = text.split('\n');
    for (const c of renumberLists(lines, first, Math.min(last, lines.length - 1)))
      lines[c.line] = lines[c.line]!.slice(0, c.from) + c.insert + lines[c.line]!.slice(c.to);
    return lines.join('\n');
  };

  it('counts on from the first item', () => {
    expect(fix('1. a\n2. new\n2. b\n3. c')).toBe('1. a\n2. new\n3. b\n4. c');
    expect(fix('1. a\n3. c\n4. d')).toBe('1. a\n2. c\n3. d');
    expect(fix('5. a\n5. b\n9. c')).toBe('5. a\n6. b\n7. c');
    expect(fix('9. a\n9. b\n10. c')).toBe('9. a\n10. b\n11. c');
  });

  it('finds the whole list from any of its lines', () => {
    expect(fix('1. a\n2. b\n2. c\n3. d', 3, 3)).toBe('1. a\n2. b\n3. c\n4. d');
    expect(fix('text\n\n1. a\n1. b\n2. c\n\nmore', 0, 0)).toBe('text\n\n1. a\n1. b\n2. c\n\nmore');
  });

  it('goes over what is set in under an item, and over empty lines within the list', () => {
    expect(fix('1. a\n   more\n   - sub\n1. b\n\n2. c')).toBe(
      '1. a\n   more\n   - sub\n2. b\n\n3. c',
    );
  });

  it('numbers a nested list by itself', () => {
    expect(fix('1. a\n   1. x\n   1. y\n   2. z\n1. b\n2. c')).toBe(
      '1. a\n   1. x\n   2. y\n   3. z\n2. b\n3. c',
    );
  });

  it('ends a list at text that is not part of it', () => {
    expect(fix('1. a\n2. b\n\ntext\n\n1. c\n3. d')).toBe('1. a\n2. b\n\ntext\n\n1. c\n2. d');
    expect(fix('1. a\n3. b\n1) c\n3) d')).toBe('1. a\n2. b\n1) c\n2) d');
  });

  it('begins at 1 where an item was set in to begin a list of its own', () => {
    const lines = ['1. a', '   3. b', '3. c'];
    expect(renumberLists(lines, 0, 2, new Set([1]))).toEqual([
      { line: 0 + 2, from: 0, to: 1, insert: '2' },
      { line: 1, from: 3, to: 4, insert: '1' },
    ]);
    // The first item of a list that was not moved keeps its number.
    expect(renumberLists(['5. a', '6. b'], 0, 1, new Set([1]))).toEqual([]);
  });

  it('leaves a list alone whose items all carry the same number', () => {
    expect(fix('1. a\n1. b\n1. c')).toBe('1. a\n1. b\n1. c');
  });
});
