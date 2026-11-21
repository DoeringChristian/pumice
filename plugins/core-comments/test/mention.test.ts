import { describe, expect, it } from 'vitest';
import { matchMentions, mentionBefore } from '../src/mention';

const all = [
  { mention: 'agent', label: 'The chat that fits best' },
  { mention: 'literature-review', label: 'Literature review', detail: 'Claude Code' },
  { mention: 'results', label: 'Results', detail: 'Codex' },
  { mention: 'claude', label: 'Claude Code', detail: 'agent' },
];

describe('@ completion in comments', () => {
  it('finds the name being typed before the cursor', () => {
    expect(mentionBefore('@', 1)).toEqual({ from: 0, typed: '' });
    expect(mentionBefore('see @Lit', 8)).toEqual({ from: 4, typed: 'lit' });
    expect(mentionBefore('see @lit and more', 8)).toEqual({ from: 4, typed: 'lit' });
    // An address, or a name that is already finished, is not being typed.
    expect(mentionBefore('me@example', 10)).toBeUndefined();
    expect(mentionBefore('@agent why', 10)).toBeUndefined();
  });

  it('offers names that start with what was typed, then those that contain it', () => {
    expect(matchMentions(all, '').map((m) => m.mention)).toEqual([
      'agent',
      'literature-review',
      'results',
      'claude',
    ]);
    expect(matchMentions(all, 're').map((m) => m.mention)).toEqual([
      'results',
      'literature-review',
    ]);
    // Found by what the chat is called, too.
    expect(matchMentions(all, 'code').map((m) => m.mention)).toEqual(['claude']);
    expect(matchMentions(all, 'zzz')).toEqual([]);
  });
});
