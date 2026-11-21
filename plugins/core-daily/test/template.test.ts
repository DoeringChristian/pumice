import { describe, expect, it } from 'vitest';
import { findTemplate } from '../src/index';

const files = [
  'templates/daily.md',
  'templates/Meeting.md',
  'notes/Daily plan.md',
  'daily/2026-01-01.md',
];
const templates = ['templates/daily.md', 'templates/Meeting.md'];

describe('the template for daily notes', () => {
  it('is found however its path is written', () => {
    expect(findTemplate('templates/daily.md', files, templates)).toBe('templates/daily.md');
    expect(findTemplate('templates/daily', files, templates)).toBe('templates/daily.md');
    expect(findTemplate('Templates/Daily.md', files, templates)).toBe('templates/daily.md');
    expect(findTemplate(' /Templates/Daily ', files, templates)).toBe('templates/daily.md');
    expect(findTemplate('[[templates/daily]]', files, templates)).toBe('templates/daily.md');
    expect(findTemplate('notes/Daily plan', files, templates)).toBe('notes/Daily plan.md');
  });
  it('is found by the name of a template alone', () => {
    expect(findTemplate('meeting', files, templates)).toBe('templates/Meeting.md');
    expect(findTemplate('old/folder/Daily.md', files, templates)).toBe('templates/daily.md');
  });
  it('is the template called "daily" when nothing is set', () => {
    expect(findTemplate('', files, templates)).toBe('templates/daily.md');
    expect(findTemplate('', files, ['templates/Meeting.md'])).toBeUndefined();
  });
  it('is nothing when it does not exist', () => {
    expect(findTemplate('templates/weekly.md', files, templates)).toBeUndefined();
  });
});
