import { describe, expect, it } from 'vitest';
import { fenceIsOpen, rightFor } from '../src/completion';

describe('fenceIsOpen', () => {
  it('tells an opening fence that still needs its closing one', () => {
    expect(fenceIsOpen(['```ts'], 0)).toBe(true);
    expect(fenceIsOpen(['```ts', 'code', '```'], 0)).toBe(false);
    // A new fence typed above a complete block: the two below belong together.
    expect(fenceIsOpen(['```', 'text', '```py', 'x', '```'], 0)).toBe(true);
    expect(fenceIsOpen(['~~~', '```', '~~~'], 0)).toBe(false);
    expect(fenceIsOpen(['plain'], 0)).toBe(false);
    // The closing fence of a block is not the start of a new one.
    expect(fenceIsOpen(['```ts', 'code', '```'], 2)).toBe(false);
    expect(fenceIsOpen(['```ts', 'code', '```', '', '```'], 4)).toBe(true);
  });
});

describe('closing \\left', () => {
  it('gives the delimiter that closes the one just typed', () => {
    expect(rightFor('a + \\left(', '')).toBe('\\right)');
    expect(rightFor('\\left[', ' + b')).toBe('\\right]');
    expect(rightFor('\\left<', '')).toBe('\\right>');
    expect(rightFor('\\left\\{', '')).toBe('\\right\\}');
    expect(rightFor('\\left|', '')).toBe('\\right|');
    expect(rightFor('\\left\\langle', '')).toBe('\\right\\rangle');
    expect(rightFor('\\left \\lVert', ' x')).toBe('\\right\\rVert');
  });
  it('adds nothing when there is nothing to close', () => {
    expect(rightFor('\\left', '')).toBeUndefined();
    expect(rightFor('(', '')).toBeUndefined();
    expect(rightFor('\\leftarrow(', '')).toBeUndefined();
    // Still being typed, or closed already.
    expect(rightFor('\\left\\lang', 'le')).toBeUndefined();
    expect(rightFor('\\left(', ' \\right)')).toBeUndefined();
    expect(rightFor('\\left\\alpha', '')).toBeUndefined();
  });
});
