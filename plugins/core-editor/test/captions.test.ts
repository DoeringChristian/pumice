import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { captionGuard } from '../src/captions';

const edit = (
  doc: string,
  changes: { at: string; insert: string; del?: number }[],
  event = 'input.paste',
) => {
  const list = changes.map(({ at, insert, del = 0 }) => {
    const from = doc.indexOf(at) + at.length;
    return { from, to: from + del, insert };
  });
  const state = EditorState.create({
    doc,
    // (Pasting: every cursor is where something is inserted.)
    selection: EditorSelection.create(list.map((c) => EditorSelection.range(c.from, c.to))),
    extensions: [captionGuard(() => false), EditorState.allowMultipleSelections.of(true)],
  });
  const set = state.changes(list);
  const tr = state.update({
    changes: list,
    selection: EditorSelection.create(list.map((c) => EditorSelection.cursor(set.mapPos(c.to, 1)))),
    userEvent: event,
  });
  return { text: tr.newDoc.toString(), cursors: tr.newSelection.ranges.map((r) => r.head), tr };
};
const wiki = '![[a.png|Cap]]{#fig-a width=50%}\n\nText\n';
const image = '![Cap](a.png){#fig-a}\n\nText\n';
const frame = (c: string) => `\`\`\`frame\nfile: f.html\ncaption: ${c}\n\`\`\`\n`;

describe('writing into a caption', () => {
  it('leaves out what would end the figure', () => {
    expect(edit(wiki, [{ at: 'Cap', insert: 'x]]y' }]).text).toBe(wiki.replace('Cap', 'Capxy'));
    expect(edit(wiki, [{ at: 'Cap', insert: '|300' }]).text).toBe(wiki.replace('Cap', 'Cap300'));
    expect(edit(wiki, [{ at: 'Cap', insert: ']' }], 'input.type').text).toBe(wiki);
    expect(edit(image, [{ at: 'Cap', insert: 'x](b.png) ' }]).text).toBe(
      image.replace('Cap', 'Capx(b.png) '),
    );
    expect(edit(image, [{ at: 'Cap', insert: '\\' }], 'input.type').text).toBe(image);
  });

  it('keeps links and ordinary text as they are', () => {
    for (const insert of [' see [[#^fig-b]]', ' 50% {of} "it" (all)', ' $x$'])
      for (const doc of [wiki, image])
        expect(edit(doc, [{ at: 'Cap', insert }]).text).toBe(doc.replace('Cap', `Cap${insert}`));
  });

  it('keeps a quoted caption of a frame valid', () => {
    expect(edit(frame('"A"'), [{ at: '"A', insert: '"b\\' }]).text).toBe(frame(`"A'b"`));
    expect(edit(frame('A'), [{ at: 'caption: A', insert: ': "b"' }]).text).toBe(frame('A: "b"'));
    expect(edit(frame('A'), [{ at: 'caption: ', insert: '"' }], 'input.type').text).toBe(
      frame('A'),
    );
  });

  it('puts lines into one, only in the caption, and keeps every cursor', () => {
    const r = edit(wiki, [
      { at: 'Cap', insert: 'x\ny' },
      { at: 'Text', insert: 'x\ny' },
    ]);
    expect(r.text).toBe(wiki.replace('Cap', 'Capx y').replace('Text', 'Textx\ny'));
    expect(r.cursors).toEqual([r.text.indexOf('x y') + 3, r.text.indexOf('x\ny') + 3]);
    expect(r.tr.isUserEvent('input.paste')).toBe(true);
  });

  it('does not make an edit that would cut into the figure', () => {
    expect(edit(wiki, [{ at: 'Ca', insert: '', del: 4 }], 'delete').text).toBe(wiki);
    expect(edit(wiki, [{ at: '', insert: '', del: wiki.indexOf('\n') }], 'delete').text).toBe(
      '\n\nText\n',
    );
  });

  it('starts a caption with a number, which is not taken for a size', () => {
    // Typed into an empty caption: an empty size behind it says it is not one.
    const two = edit('![[a.png|]]\n', [{ at: '|', insert: '2' }], 'input.type');
    expect(two.text).toBe('![[a.png|2|]]\n');
    expect(two.cursors).toEqual([10]);
    // Once it reads as words, the empty size goes.
    expect(edit(two.text, [{ at: '|2', insert: ' bodies' }], 'input.type').text).toBe(
      '![[a.png|2 bodies]]\n',
    );
    // Deleting back to a number brings it again.
    expect(edit('![[a.png|2x]]\n', [{ at: '|2', insert: '', del: 1 }], 'delete').text).toBe(
      '![[a.png|2|]]\n',
    );
    // Before a size that is there: the bar is the one in front of the size.
    expect(edit('![[a.png|300]]\n', [{ at: '|', insert: '2' }], 'input.type').text).toBe(
      '![[a.png|2|300]]\n',
    );
    expect(edit('![](a.png){#fig-a}\n', [{ at: '![', insert: '3' }], 'input.type').text).toBe(
      '![3|](a.png){#fig-a}\n',
    );
  });

  it('leaves a figure at the end of the note writable', () => {
    expect(edit('![[a.png|]]', [{ at: '|', insert: 'N' }], 'input.type').text).toBe('![[a.png|N]]');
    expect(edit('![](a.png)', [{ at: '![', insert: 'N' }], 'input.type').text).toBe('![N](a.png)');
    expect(
      edit(
        frame('A'),
        [
          { at: 'caption: A', insert: '', del: 0 },
          { at: 'caption: ', insert: '', del: 1 },
        ],
        'delete',
      ).text,
    ).toBe(frame(''));
  });

  it('takes the place of what was selected, and leaves a cursor behind it', () => {
    for (const back of [false, true]) {
      const from = wiki.indexOf('Cap');
      const state = EditorState.create({
        doc: wiki,
        selection: back ? { anchor: from + 3, head: from } : { anchor: from, head: from + 3 },
        extensions: [captionGuard(() => false), history()],
      });
      const tr = state.update(state.replaceSelection('x\ny'), { userEvent: 'input.paste' });
      expect(tr.newDoc.toString()).toBe(wiki.replace('Cap', 'x y'));
      expect([tr.newSelection.main.empty, tr.newSelection.main.head]).toEqual([true, from + 3]);
      let now = tr.state;
      undo({ state: now, dispatch: (t) => (now = t.state) });
      expect(now.doc.toString()).toBe(wiki);
    }
  });

  it('lets words of a frame caption go, also the first', () => {
    const doc = frame('First second');
    for (const [at, del, left] of [
      ['caption: ', 5, ' second'],
      ['caption: First', 7, 'First'],
      ['caption: ', 12, ''],
    ] as const)
      expect(edit(doc, [{ at, insert: '', del }], 'delete').text).toBe(frame(left));
  });

  it('knows several figures of a line, and table cells', () => {
    const row = '![[a.png|One]]{width=40%} ![[b.png|Two]]{width=40%}\n';
    expect(edit(row, [{ at: 'Two', insert: ']]!' }]).text).toBe(row.replace('Two', 'Two!'));
    expect(
      edit(row, [
        { at: 'One', insert: ' x' },
        { at: 'Two', insert: ' y' },
      ]).text,
    ).toBe(row.replace('One', 'One x').replace('Two', 'Two y'));
    const cell = '| a |\n| - |\n| ![[a.png\\|Cap]] |\n';
    expect(edit(cell, [{ at: 'Cap', insert: 'tion' }], 'input.type').text).toBe(
      cell.replace('Cap', 'Caption'),
    );
    expect(edit(cell, [{ at: 'Cap', insert: '|' }], 'input.type').text).toBe(cell);
  });

  it('keeps a table whole that has no bars at its sides', () => {
    for (const doc of [
      'Figure | Notes\n--- | ---\n![Cap](a.png) | text\n',
      '![Cap](a.png) | Notes\n:-- | --:\nx | y\n',
    ])
      expect(edit(doc, [{ at: 'Cap', insert: 'a|b' }]).text).toBe(doc.replace('Cap', 'Capab'));
    // Elsewhere a bar is text (a norm, say).
    expect(edit(image, [{ at: 'Cap', insert: ' $|x|$' }]).text).toBe(
      image.replace('Cap', 'Cap $|x|$'),
    );
  });

  it('lets a composition replace what it has written so far', () => {
    expect(edit(wiki, [{ at: 'C', insert: 'あ', del: 1 }], 'input.type.compose').text).toBe(
      wiki.replace('Cap', 'Cあp'),
    );
  });
});
