import { describe, expect, it } from 'vitest';
import { slideAt, splitSlides } from '../src/slides';

const texts = (note: string) => splitSlides(note).map((s) => s.text);

describe('a note as slides', () => {
  it('starts a new slide at a line with ---', () => {
    expect(texts('# One\n\ntext\n\n---\n\n# Two\n\n---\n\n# Three\n')).toEqual([
      '# One\n\ntext',
      '# Two',
      '# Three',
    ]);
  });

  it('is one slide without separators', () => {
    expect(texts('# Only\n\ntext\n')).toEqual(['# Only\n\ntext']);
  });

  it('leaves the properties out', () => {
    expect(texts('---\ntitle: Talk\n---\n# One\n\n---\n\n# Two\n')).toEqual(['# One', '# Two']);
  });

  it('takes --- right under text for a heading, not a separator', () => {
    expect(texts('Title\n---\n\ntext\n\n---\n\nnext\n')).toEqual(['Title\n---\n\ntext', 'next']);
  });

  it('does not split inside a code block', () => {
    expect(texts('```yaml\na: 1\n\n---\n\nb: 2\n```\n\n---\n\nnext\n')).toEqual([
      '```yaml\na: 1\n\n---\n\nb: 2\n```',
      'next',
    ]);
  });

  it('skips empty slides', () => {
    expect(texts('one\n\n---\n\n---\n\ntwo\n\n---\n')).toEqual(['one', 'two']);
  });

  it('knows which slide a place in the note is on', () => {
    const note = '# One\n\n---\n\n# Two\n\n---\n\n# Three\n';
    const slides = splitSlides(note);
    expect(slideAt(slides, 0)).toBe(0);
    expect(slideAt(slides, note.indexOf('# Two') + 2)).toBe(1);
    expect(slideAt(slides, note.length)).toBe(2);
    // In the properties: the first slide.
    expect(slideAt(splitSlides('---\na: 1\n---\n# One\n'), 2)).toBe(0);
  });
});
