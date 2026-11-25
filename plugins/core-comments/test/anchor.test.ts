import { describe, expect, it } from 'vitest';
import { createAnchor, formerPlace, resolveAnchor } from '../src/anchor';

describe('comment anchors', () => {
  const text = 'The cat sat on the mat. The cat ran away. A dog sat too.';

  it('finds text that has not moved', () => {
    const a = createAnchor(text, 24, 31); // second "The cat"
    expect(resolveAnchor(text, a)).toEqual({ from: 24, to: 31 });
  });

  it('follows text moved by an edit before it, using the context to pick the occurrence', () => {
    const a = createAnchor(text, 24, 31);
    const edited = 'Intro. ' + text.replace('sat on', 'was sitting on');
    const r = resolveAnchor(edited, a)!;
    expect(edited.slice(r.from, r.to)).toBe('The cat');
    expect(edited.slice(r.to, r.to + 9)).toBe(' ran away');
  });

  it('prefers matching context over a closer occurrence', () => {
    const a = createAnchor(text, 4, 7); // first "cat", followed by " sat on the mat"
    // Swap the sentences: the first "cat" (with " sat on") is now the second occurrence.
    const edited = 'The cat ran away. The cat sat on the mat. A dog sat too.';
    const r = resolveAnchor(edited, a)!;
    expect(edited.slice(r.to, r.to + 7)).toBe(' sat on');
  });

  it('returns null when the text is gone', () => {
    const a = createAnchor(text, 44, 47); // "dog"
    expect(resolveAnchor(text.replace('dog', 'bird'), a)).toBeNull();
  });

  it('does not move to the same word elsewhere when its own was deleted, and returns to it', () => {
    const a = createAnchor(text, 44, 47); // "dog"
    const gone = `${text.replace('dog ', '')} Every dog barks.`;
    expect(resolveAnchor(gone, a)).toBeNull();
    expect(gone.slice(0, formerPlace(gone, a)).endsWith('away. A ')).toBe(true);
    expect(resolveAnchor(`${text} Every dog barks.`, a)).toEqual({ from: 44, to: 47 });
  });

  it('finds a longer text wherever it was moved to', () => {
    const a = createAnchor(text, 0, 23);
    expect(resolveAnchor(`Other things. ${text.slice(0, 23)}`, a)?.from).toBe(14);
  });
});
