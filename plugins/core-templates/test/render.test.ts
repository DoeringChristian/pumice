import { expect, it } from 'vitest';
import { formatDate, renderTemplate } from '../src/render';

const date = new Date(2026, 10, 1, 9, 5, 7); // Sunday 1 November 2026

it('formats dates', () => {
  expect(formatDate(date, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-11-01 09:05:07');
  expect(formatDate(date, 'dddd, D MMMM [week] ww')).toBe('Sunday, 1 November week 44');
});

it('renders variables and drops the template ID', () => {
  const tpl =
    '---\nid: k7f3qm2xa1\ntags: [daily]\n---\n# {{title}}\nCreated {{date}} {{time}} ({{date:ddd}})\n';
  expect(renderTemplate(tpl, { title: 'My note', date })).toBe(
    '---\ntags: [daily]\n---\n# My note\nCreated 2026-11-01 09:05 (Sun)\n',
  );
  expect(renderTemplate('---\nid: x\n---\nBody', { date })).toBe('Body');
});
