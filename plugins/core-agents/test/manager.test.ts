import { Emitter } from '@pumice/api';
import { describe, expect, it } from 'vitest';
import { Ledger, locateChange, revertChange, StaleEditError, trackedFiles } from '../src/ledger';
import { ChatManager, chatName, chatState, mentionOf } from '../src/manager';
import type { AgentFiles, ChatSession, SessionStatus, TranscriptItem } from '../src/session';

let ids = 0;
/** A session that answers when told to. */
function fakeSession(agent: string) {
  const changed = new Emitter<void>();
  const prompts: string[] = [];
  let finish: (() => void) | undefined;
  const s: ChatSession = {
    config: { id: agent, name: agent, command: '', args: [] },
    chatId: `chat-${++ids}`,
    items: [] as TranscriptItem[],
    status: 'starting' as SessionStatus,
    modes: [],
    currentMode: undefined,
    models: [],
    currentModel: undefined,
    commands: [],
    loginOptions: [],
    onDidChange: changed.event,
    snapshot: () => ({ items: s.items }),
    start: async () => undefined,
    authenticate: async () => undefined,
    setMode: async () => undefined,
    setModel: async () => undefined,
    prompt(text: string) {
      prompts.push(text);
      s.items.push({ kind: 'user', id: s.items.length, text });
      s.status = 'working';
      changed.fire();
      return new Promise<void>((resolve) => {
        finish = () => {
          s.items.push({ kind: 'agent', id: s.items.length, text: `re: ${text}` });
          s.status = 'ready';
          resolve();
          changed.fire();
        };
      });
    },
    cancel: () => finish?.(),
    dispose: () => undefined,
  };
  return {
    s,
    prompts,
    ready() {
      s.status = 'ready';
      changed.fire();
    },
    answer: () => finish?.(),
  };
}

function setup() {
  const made: Array<ReturnType<typeof fakeSession>> = [];
  const manager = new ChatManager((agent) => {
    const f = fakeSession(agent);
    made.push(f);
    return f.s;
  });
  return { manager, made };
}

const tick = () => new Promise((r) => setTimeout(r));
const item = (message: string) => ({ message, blocks: [], label: undefined });

describe('several chats', () => {
  it('keeps a chat working while another one is shown', async () => {
    const { manager, made } = setup();
    const a = manager.start('chatgpt');
    const b = manager.start('claude');
    made[0]!.ready();
    made[1]!.ready();
    manager.show(a.session.chatId);
    manager.send(a, item('first'));
    manager.show(b.session.chatId);
    expect(chatState(a)).toBe('working');
    made[0]!.answer();
    await tick();
    // It finished while the other chat was on screen.
    expect(chatState(a)).toBe('unread');
    expect(manager.waiting()).toBe(1);
    manager.show(a.session.chatId);
    expect(chatState(a)).toBe('idle');
    expect(manager.waiting()).toBe(0);
  });

  it('sends queued messages one at a time, and tells who asked what came back', async () => {
    const { manager, made } = setup();
    const chat = manager.start('chatgpt');
    manager.send(chat, item('one'));
    // Not started yet: it waits.
    expect(made[0]!.prompts).toEqual([]);
    made[0]!.ready();
    const answer = manager.ask(chat, item('two'));
    expect(made[0]!.prompts).toEqual(['one']);
    expect(chat.queue).toHaveLength(1);
    made[0]!.answer();
    await tick();
    expect(made[0]!.prompts).toEqual(['one', 'two']);
    made[0]!.answer();
    const produced = await answer;
    expect(produced.map((i) => i.kind)).toEqual(['user', 'agent']);
    expect(produced[1]).toMatchObject({ text: 're: two' });
  });

  it('puts an interrupting message first', async () => {
    const { manager, made } = setup();
    const chat = manager.start('chatgpt');
    made[0]!.ready();
    manager.send(chat, item('long task'));
    manager.send(chat, item('later'));
    manager.send(chat, item('now'), true);
    await tick();
    expect(made[0]!.prompts).toEqual(['long task', 'now']);
  });

  it('tells a waiting asker when the chat is closed', async () => {
    const { manager, made } = setup();
    const chat = manager.start('chatgpt');
    made[0]!.ready();
    manager.send(chat, item('busy'));
    const answer = manager.ask(chat, item('comment'));
    manager.close(chat.session.chatId);
    await expect(answer).rejects.toThrow(/stopped/);
    expect(manager.open).toHaveLength(0);
  });

  it('finds a chat by the name written after @', () => {
    const { manager, made } = setup();
    const a = manager.start('chatgpt');
    const b = manager.start('claude');
    made[0]!.ready();
    manager.rename(a.session.chatId, 'Literature review');
    expect(chatName(a)).toBe('Literature review');
    expect(mentionOf('Literature review')).toBe('literature-review');
    expect(manager.byMention('literature-review')).toBe(a);
    expect(manager.byMention('Literature-Review')).toBe(a);
    // An agent's id means its most recent chat.
    expect(manager.byMention('claude')).toBe(b);
    expect(manager.byMention('nobody')).toBeUndefined();
  });
});

function memoryFs() {
  const stored = new Map<string, string>();
  return {
    stored,
    fs: {
      stat: async (p: string) => (stored.has(p) ? ({ path: p } as never) : null),
      readText: async (p: string) => stored.get(p)!,
      write: async (p: string, data: string | Uint8Array) => {
        stored.set(p, String(data));
        return { path: p } as never;
      },
    } as never,
  };
}

function vaultFiles(initial: Record<string, string>): AgentFiles & { text: Map<string, string> } {
  const text = new Map(Object.entries(initial));
  return {
    text,
    root: '/vault',
    read: async (p) => {
      if (!text.has(p)) throw new Error('no such file');
      return text.get(p)!;
    },
    write: async (p, c) => void text.set(p, c),
  };
}

describe('edits by several chats', () => {
  it('refuses to overwrite what a chat has not seen, once', async () => {
    const base = vaultFiles({ 'report.md': 'one\ntwo\n' });
    const ledger = new Ledger(memoryFs().fs);
    const a = trackedFiles(base, ledger, () => ({ id: 'a', name: 'A' }));
    const b = trackedFiles(base, ledger, () => ({ id: 'b', name: 'B' }));
    const seenByA = await a.read('report.md');
    await b.read('report.md');
    await b.write('report.md', 'one\ntwo\nthree\n');
    // A still has the old text: its version would drop B's line.
    await expect(a.write('report.md', seenByA.replace('one', 'ONE'))).rejects.toThrow(
      StaleEditError,
    );
    expect(base.text.get('report.md')).toBe('one\ntwo\nthree\n');
    const fresh = await a.read('report.md');
    await a.write('report.md', fresh.replace('one', 'ONE'));
    expect(base.text.get('report.md')).toBe('ONE\ntwo\nthree\n');
  });

  it('lets a chat create files and write what it wrote itself', async () => {
    const base = vaultFiles({});
    const ledger = new Ledger(memoryFs().fs);
    const a = trackedFiles(base, ledger, () => ({ id: 'a', name: 'A' }));
    await a.write('new.md', 'hello\n');
    await a.write('new.md', 'hello there\n');
    expect(base.text.get('new.md')).toBe('hello there\n');
    expect(ledger.changesFor('new.md')).toHaveLength(2);
  });

  it('knows which chat wrote a passage, and takes a change back', async () => {
    const base = vaultFiles({ 'report.md': '# Report\n\nIntro.\n\nEnd.\n' });
    const ledger = new Ledger(memoryFs().fs);
    const a = trackedFiles(base, ledger, () => ({ id: 'a', name: 'Methods' }));
    const b = trackedFiles(base, ledger, () => ({ id: 'b', name: 'Results' }));
    await a.write(
      'report.md',
      (await a.read('report.md')).replace('Intro.', 'Intro.\n\nMethods text.'),
    );
    await b.write(
      'report.md',
      (await b.read('report.md')).replace('End.', 'Results text.\n\nEnd.'),
    );
    const text = base.text.get('report.md')!;
    const at = (needle: string) => ({
      from: text.indexOf(needle),
      to: text.indexOf(needle) + needle.length,
    });
    expect(ledger.chatForRange('report.md', text, at('Methods'))).toBe('a');
    expect(ledger.chatForRange('report.md', text, at('Results text'))).toBe('b');
    expect(ledger.chatForRange('report.md', text, at('# Report'))).toBeUndefined();

    const [latest, first] = ledger.changesFor('report.md');
    expect(latest!.chat).toBe('Results');
    expect(locateChange(first!, text)).toBeDefined();
    expect(revertChange(first!, text)).toBe('# Report\n\nIntro.\n\nResults text.\n\nEnd.\n');
    // Once the text was edited further, the change is not taken back blindly.
    expect(revertChange(first!, text.replace('Methods text', 'Other text'))).toBeUndefined();
  });

  it('remembers which chat answers a thread across a restart', async () => {
    const { fs } = memoryFs();
    const ledger = new Ledger(fs);
    ledger.setThreadChat('t1', 'a');
    await ledger.flush();
    const again = new Ledger(fs);
    await again.load();
    expect(again.threadChat('t1')).toBe('a');
    expect(again.threadChat('t2')).toBeUndefined();
  });
});
