import { describe, expect, it } from 'vitest';
import { moveEmbed } from '../src/drag-embed';

const apply = (text: string, m: ReturnType<typeof moveEmbed>) =>
  m ? text.slice(0, m.change.from) + m.change.insert + text.slice(m.change.to) : text;
const range = (text: string, embed: string) => {
  const from = text.indexOf(embed);
  return { from, to: from + embed.length };
};

describe('moving an embed by dragging it', () => {
  const note = 'One.\n\n![[a.png|Cap|350]] ^fig-a\n\nTwo.\n\nThree.\n';
  const fig = '![[a.png|Cap|350]]';
  it('moves a figure with its label below another paragraph', () => {
    const m = moveEmbed(note, range(note, fig), note.indexOf('Three'), 'after');
    const out = apply(note, m);
    expect(out).toBe('One.\n\nTwo.\n\nThree.\n\n![[a.png|Cap|350]]{#fig-a}\n');
    expect(out.slice(m!.at)).toMatch(/^!\[\[a\.png/);
  });
  it('moves it above the first paragraph', () => {
    const m = moveEmbed(note, range(note, fig), 1, 'before');
    expect(apply(note, m)).toBe('![[a.png|Cap|350]]{#fig-a}\n\nOne.\n\nTwo.\n\nThree.\n');
  });
  it('moves it between two paragraphs, onto the empty line', () => {
    const m = moveEmbed(note, range(note, fig), note.indexOf('\nThree'), 'before');
    expect(apply(note, m)).toBe('One.\n\nTwo.\n\n![[a.png|Cap|350]]{#fig-a}\n\nThree.\n');
  });
  it('does nothing when dropped where it is', () => {
    expect(moveEmbed(note, range(note, fig), note.indexOf('![[') + 3, 'after')).toBeNull();
    const tight = 'A.\n\n![[a.png]]\n\nB.';
    expect(moveEmbed(tight, range(tight, '![[a.png]]'), tight.indexOf('B.'), 'before')).toBeNull();
    expect(moveEmbed(tight, range(tight, '![[a.png]]'), 1, 'after')).toBeNull();
  });
  it('leaves no empty lines behind, wherever it stood', () => {
    for (const text of [
      '![[a.png]]\n\nA.\n\nB.',
      'A.\n\n![[a.png]]\n\nB.',
      'A.\n![[a.png]]\nB.\n\nC.',
      'A.\n\nB.\n\n![[a.png]]',
      'A.\n\nB.\n\n![[a.png]]\n',
    ]) {
      for (const [word, how] of [
        ['A.', 'before'],
        ['A.', 'after'],
        ['B.', 'before'],
        ['B.', 'after'],
      ] as const) {
        const out = apply(
          text,
          moveEmbed(text, range(text, '![[a.png]]'), text.indexOf(word), how),
        );
        expect(out, `${JSON.stringify(text)} ${how} ${word}`).not.toMatch(/\n\n\n|^\n/);
        expect(out).toContain('![[a.png]]');
        expect(out.match(/!\[\[a\.png\]\]/g)).toHaveLength(1);
      }
    }
  });
  it('puts a figure beside another one, into its line', () => {
    const text = 'A.\n\n![[a.png|One]]{#fig-a}\n\nB.\n\n![[b.png|Two|300]]\n\nC.';
    const b = range(text, '![[b.png|Two|300]]');
    const a = range(text, '![[a.png|One]]{#fig-a}');
    expect(apply(text, moveEmbed(text, b, a.to, 'inline'))).toBe(
      'A.\n\n![[a.png|One]]{#fig-a} ![[b.png|Two|300]]\n\nB.\n\nC.',
    );
    expect(apply(text, moveEmbed(text, b, a.from, 'inline'))).toBe(
      'A.\n\n![[b.png|Two|300]] ![[a.png|One]]{#fig-a}\n\nB.\n\nC.',
    );
    expect(apply(text, moveEmbed(text, a, b.to, 'inline'))).toBe(
      'A.\n\nB.\n\n![[b.png|Two|300]] ![[a.png|One]]{#fig-a}\n\nC.',
    );
  });
  it('moves a picture within a row, and out of it', () => {
    const row = 'x\n\n![[a.png|200]] ![[b.png|200]] ![[c.png|200]]\n\ny';
    const a = range(row, '![[a.png|200]]');
    const c = range(row, '![[c.png|200]]');
    expect(apply(row, moveEmbed(row, a, c.to, 'inline'))).toBe(
      'x\n\n![[b.png|200]] ![[c.png|200]] ![[a.png|200]]\n\ny',
    );
    expect(apply(row, moveEmbed(row, c, a.from, 'inline'))).toBe(
      'x\n\n![[c.png|200]] ![[a.png|200]] ![[b.png|200]]\n\ny',
    );
    expect(apply(row, moveEmbed(row, a, row.indexOf('y'), 'after'))).toBe(
      'x\n\n![[b.png|200]] ![[c.png|200]]\n\ny\n\n![[a.png|200]]',
    );
    // Above or below the row it was in.
    expect(apply(row, moveEmbed(row, c, a.from, 'before'))).toBe(
      'x\n\n![[c.png|200]]\n\n![[a.png|200]] ![[b.png|200]]\n\ny',
    );
  });
});
