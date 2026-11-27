import { describe, expect, it } from 'vitest';
import { AgentChats } from '../src/sessions.ts';

describe('agent chats', () => {
  it('keeps the list of open chats as it is last, however its writes finish', async () => {
    const written: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let writes = 0;
    const fs = {
      stat: async () => null,
      readText: async () => {
        throw new Error('none');
      },
      // The first write is held until the list has changed again.
      write: async (path: string, data: string) => {
        if (writes++ === 0) await held;
        if (path.endsWith('open.json')) written.push(data.trim());
        return { path } as never;
      },
      remove: async () => undefined,
    };
    const chats = new AgentChats({
      root: '/folder',
      fs: fs as never,
      vault: {} as never,
      documents: {} as never,
      agents: [],
      processes: {} as never,
    });
    const inner = chats as unknown as {
      chats: Map<string, { id: string; open: boolean }>;
      setOpen(chat: unknown, open: boolean): void;
      openWrites: Promise<void>;
    };
    const chat = { id: 'a-1', open: false };
    inner.chats.set(chat.id, chat);
    inner.setOpen(chat, true);
    // The first write is under way (held); the list changes meanwhile.
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toBe(1);
    inner.setOpen(chat, false);
    release();
    await inner.openWrites;
    expect(written).toEqual(['["a-1"]', '[]']);
  });
});
