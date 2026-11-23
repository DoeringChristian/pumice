import { describe, expect, it } from 'vitest';
import { leapTargets, pruneTargets } from '../src/leap';

describe('leap', () => {
  const text = 'the quick brown fox; then the lazy dog. The end.';
  const places = (targets: ReturnType<typeof leapTargets>) =>
    targets.map((t) => `${t.pos}:${text.slice(t.pos, t.pos + 2)}=${t.label}`);

  it('labels every place the first character stands, per pair, nearest first', () => {
    // "t" stands in: the(0) then(21) the(26) The(40).
    const targets = leapTargets(text, 0, 't', 20);
    expect(places(targets)).toEqual(['0:th=n', '21:th=s', '26:th=f', '40:Th=j']);
  });

  it('gives each pair its own run of labels', () => {
    // "e" stands before " ", "n", " ", " ", "n": two pairs, each from the first label.
    const targets = leapTargets('e n en e en', 0, 'e', 0, 'ab');
    expect(targets.map((t) => `${t.pos}:${t.second}=${t.label}`)).toEqual([
      '4:n=a',
      '7: =a',
      '9:n=b',
    ]);
  });

  it('keeps the places of the pair once the second character is typed', () => {
    const targets = leapTargets(text, 0, 't', 20);
    expect(places(pruneTargets(targets, 'h'))).toEqual(['0:th=n', '21:th=s', '26:th=f', '40:Th=j']);
    expect(pruneTargets(targets, 'x')).toEqual([]);
    const q = leapTargets(text, 0, 'q', 20);
    expect(places(pruneTargets(q, 'u'))).toEqual(['4:qu=s']);
  });

  it('finds upper case with lower case, but not the other way round', () => {
    expect(places(leapTargets(text, 0, 'T', 0))).toEqual(['40:Th=s']);
    expect(leapTargets(text, 0, 't', 0).map((t) => t.pos)).toEqual([21, 26, 40]);
  });

  it('goes one way only when asked: down with s, up with S', () => {
    expect(leapTargets(text, 0, 't', 20, undefined, 1).map((t) => t.pos)).toEqual([21, 26, 40]);
    expect(leapTargets(text, 0, 't', 20, undefined, -1).map((t) => t.pos)).toEqual([0]);
    expect(leapTargets(text, 0, 't', 0, undefined, -1)).toEqual([]);
  });

  it('counts from where the text starts, and has no more places per pair than labels', () => {
    expect(leapTargets('abab', 100, 'a', 100).map((t) => t.pos)).toEqual([102]);
    expect(leapTargets('ab'.repeat(200), 0, 'a', 0, 'xyz')).toHaveLength(3);
  });
});
