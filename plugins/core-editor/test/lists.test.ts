import { describe, expect, it } from 'vitest';
import { continuationIndent, markerStart, nextItemPrefix } from '../src/lists';

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
