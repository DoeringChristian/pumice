import { describe, expect, it } from 'vitest';
import { Remembered } from '../src/remembered';

const make = (most?: number) => new Remembered<{ n: number }>((a, b) => a.n === b.n, most);

describe('remembered values', () => {
  it('are kept and read again', () => {
    let saved = '';
    const a = make();
    a.keep(undefined, (t) => (saved = t));
    a.learn('x', { n: 1 });
    a.learn('y', { n: 2 });
    a.forget('y');
    a.dispose();
    const b = make();
    b.keep(saved, () => undefined);
    expect(b.get('x')).toEqual({ n: 1 });
    expect(b.get('y')).toBeUndefined();
  });
  it('give way to what was learned since, and to what cannot be read', () => {
    const a = make();
    a.learn('x', { n: 5 });
    a.keep('[["x",{"n":1}],["z"', () => undefined);
    a.keep('[["x",{"n":1}]]', () => undefined);
    expect(a.get('x')).toEqual({ n: 5 });
    a.dispose();
  });
  it('make room for new ones', () => {
    const a = make(2);
    for (const k of ['a', 'b', 'c']) a.learn(k, { n: 1 });
    expect(a.get('a')).toBeUndefined();
    expect(a.get('c')).toBeDefined();
    a.dispose();
  });
});
