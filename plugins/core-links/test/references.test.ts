import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { itemChoices, matchScore } from '../src/references';

describe('finding what to refer to', () => {
  const state = EditorState.create({
    doc: [
      '![[a.png|Loss curve of the first run]]{#fig-a}',
      '',
      '![[b.png|Rendering with caustics]]',
      '',
      'Table: Runs per method',
      '',
      '| a |',
      '| - |',
    ].join('\n'),
  });
  const found = (query: string) =>
    itemChoices(state)
      .map((c) => ({ label: c.label, score: matchScore(c, query) }))
      .filter((c) => c.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((c) => c.label.split(':')[0]);

  it('by what it is called', () => {
    expect(found('Figure 2')).toEqual(['Figure 2']);
    expect(found('figure2')).toEqual(['Figure 2']);
    expect(found('fig1')[0]).toBe('Figure 1');
    expect(found('table 1')).toEqual(['Table 1']);
    expect(found('fig')).toEqual(['Figure 1', 'Figure 2']);
    expect(found('')).toHaveLength(3);
  });
  it('by its label and by its caption, loosely', () => {
    expect(found('fig-a')[0]).toBe('Figure 1');
    expect(found('caustics')).toEqual(['Figure 2']);
    expect(found('losscrv')).toEqual(['Figure 1']);
    expect(found('rndcaus')).toEqual(['Figure 2']);
    expect(found('runsmethod')).toEqual(['Table 1']);
    expect(found('zzz')).toEqual([]);
  });
});
