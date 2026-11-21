/** What a toolbar button that toggles the start of a line (checklist item, heading) looks for. */
export interface LinePrefix {
  /** The prefix when it is there, matched after the line's indentation: the button removes it. */
  present: RegExp;
  /** Something the prefix takes the place of (a plain bullet for a checklist item). */
  replaces?: RegExp;
  insert: string;
}

export const TASK_PREFIX: LinePrefix = {
  present: /^[-*+] \[[ xX]\] /,
  replaces: /^(?:[-*+]|\d+[.)]) /,
  insert: '- [ ] ',
};

export const HEADING_PREFIX: LinePrefix = { present: /^#{1,6} /, insert: '## ' };

/**
 * The change, in offsets within the line, that toggles `prefix` on a line, and where a cursor
 * at `head` goes: it never ends up in front of or inside what was added. Indentation stays.
 */
export function linePrefixChange(
  line: string,
  prefix: LinePrefix,
  head = 0,
): { from: number; to: number; insert: string; head: number } {
  const indent = /^[ \t]*/.exec(line)![0].length;
  const rest = line.slice(indent);
  const present = prefix.present.exec(rest);
  const replaced = present ?? prefix.replaces?.exec(rest);
  const to = indent + (replaced ? replaced[0].length : 0);
  const insert = present ? '' : prefix.insert;
  const moved = head < indent ? head : Math.max(head, to) - (to - indent) + insert.length;
  return { from: indent, to, insert, head: moved };
}
