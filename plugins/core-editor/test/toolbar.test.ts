import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { HEADING_PREFIX, linePrefixChange, TASK_PREFIX, type LinePrefix } from '../src/toolbar';

/** Applies the toggle to `doc`, where `|` marks the cursor, the way the toolbar button does. */
function toggle(doc: string, prefix: LinePrefix): string {
  const head = doc.indexOf('|');
  const state = EditorState.create({ doc: doc.replace('|', '') });
  const line = state.doc.lineAt(head);
  const c = linePrefixChange(line.text, prefix, head - line.from);
  const text = state
    .update({ changes: { from: line.from + c.from, to: line.from + c.to, insert: c.insert } })
    .state.doc.toString();
  const at = line.from + c.head;
  return text.slice(0, at) + '|' + text.slice(at);
}

describe('toolbar line prefixes', () => {
  it('puts the cursor after a checkbox added to an empty line', () => {
    expect(toggle('|', TASK_PREFIX)).toBe('- [ ] |');
    expect(toggle('a\n|\nb', TASK_PREFIX)).toBe('a\n- [ ] |\nb');
  });
  it('keeps the cursor where it was in the text', () => {
    expect(toggle('|buy milk', TASK_PREFIX)).toBe('- [ ] |buy milk');
    expect(toggle('buy| milk', TASK_PREFIX)).toBe('- [ ] buy| milk');
  });
  it('turns a bullet into a checkbox and keeps the indentation', () => {
    expect(toggle('  - |', TASK_PREFIX)).toBe('  - [ ] |');
    expect(toggle('  |- item', TASK_PREFIX)).toBe('  - [ ] |item');
    expect(toggle(' | - item', TASK_PREFIX)).toBe(' | - [ ] item');
    expect(toggle('1. item|', TASK_PREFIX)).toBe('- [ ] item|');
  });
  it('removes a checkbox that is there', () => {
    expect(toggle('  - [x] done|', TASK_PREFIX)).toBe('  done|');
    expect(toggle('- [ |] ', TASK_PREFIX)).toBe('|');
  });
  it('toggles a heading', () => {
    expect(toggle('|', HEADING_PREFIX)).toBe('## |');
    expect(toggle('## Title|', HEADING_PREFIX)).toBe('Title|');
  });
});
