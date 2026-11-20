import { describe, expect, it } from 'vitest';
import { fenceIsOpen } from '../src/completion';

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
