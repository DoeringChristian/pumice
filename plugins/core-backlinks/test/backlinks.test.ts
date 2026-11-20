import { expect, it } from 'vitest';
import { prettify } from '../src';

it('prettify keeps the highlight on the link text', () => {
  const context = 'See [[abc|First]] and [[def|Second]] now';
  const from = context.indexOf('[[def');
  const to = from + '[[def|Second]]'.length;
  const out = prettify(context, [from, to], (inner) => inner.split('|')[1]!);
  expect(out.context).toBe('See First and Second now');
  expect(out.context.slice(...out.range)).toBe('Second');
});
