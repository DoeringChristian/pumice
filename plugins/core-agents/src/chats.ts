import type { PlatformFs } from '@pumice/api';
import type { TranscriptItem } from './session';

/**
 * Conversations with agents, kept in `.pumice/chats/` so they can be picked up later:
 * what was said, and what the agent needs to continue (the built-in assistant's conversation
 * state, or an external agent's session id).
 */

export interface ChatSnapshot {
  items: TranscriptItem[];
  /** The built-in assistant's conversation, as it is sent to the model. */
  input?: unknown[];
  /** An external agent's own id for the conversation. */
  sessionId?: string;
  /** The chat answers the agent's questions itself ("allow everything in this chat"). */
  autoApprove?: boolean;
  /** The model and the reasoning effort chosen in the chat (an external agent's). */
  model?: string;
  effort?: string;
}

export interface SavedChat extends ChatSnapshot {
  version: 1;
  id: string;
  /** Agent id (`chatgpt`, `claude`, …). */
  agent: string;
  title: string;
  /** A name the user gave the chat (the title is then this name). */
  name?: string;
  /** The chat this one was forked from: it starts with that conversation. */
  forkedFrom?: string;
  /** Who started it (a server's chats: the user there). */
  by?: { id: string; name: string };
  /**
   * Who sees it: absent, everyone in the vault. (`private`: only `by`; not yet offered, see
   * docs/plan/11.)
   */
  visibility?: 'private';
  /** ISO timestamps. */
  created: string;
  updated: string;
}

export type ChatSummary = Pick<
  SavedChat,
  'id' | 'agent' | 'title' | 'name' | 'created' | 'updated' | 'by' | 'visibility'
>;

export const CHATS_DIR = '.pumice/chats';
const MAX_CHATS = 200;

export const newChatId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** What a conversation is called in the list: its first message, shortened. */
export function chatTitle(items: TranscriptItem[]): string {
  const first = items.find((i) => i.kind === 'user');
  const text = (first && 'text' in first ? first.text : '').replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
}

/** What was said so far, as text for an agent that starts a fork without remembering it. */
export function transcriptText(items: TranscriptItem[], limit = 24_000): string {
  const said = items.flatMap((item) =>
    item.kind === 'user'
      ? [`User: ${item.text}`]
      : item.kind === 'agent'
        ? [`Assistant: ${item.text}`]
        : [],
  );
  let text = said.join('\n\n');
  // The end of a long conversation matters most.
  if (text.length > limit) text = `[…]\n${text.slice(text.length - limit)}`;
  return text;
}

/** The transcript as it can be written to a file: nothing is left waiting or running. */
export function storableItems(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind === 'permission') {
      const { respond: _respond, ...rest } = item;
      return { ...rest, chosen: rest.chosen ?? 'cancelled' };
    }
    if (item.kind === 'tool') {
      // Pictures shown to the agent are not kept with the chat: they are large.
      const content = item.content.filter(
        (c) => !(c.type === 'content' && c.content.type === 'image'),
      );
      const kept = content.length === item.content.length ? item : { ...item, content };
      return kept.status === 'in_progress' || kept.status === 'pending'
        ? { ...kept, status: 'cancelled' }
        : kept;
    }
    return item;
  });
}

/** "2 hours ago"-style age of a conversation, for the list. */
export function age(updated: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(updated)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(updated).toLocaleDateString();
}

export class ChatStore {
  private index: ChatSummary[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly fs: PlatformFs) {}

  private file(id: string): string {
    // (The folder's own files are not chats: `index.json`, `ledger.json`, `open.json`.)
    if (!/^[\w-]+$/.test(id) || /^(index|ledger|open)$/i.test(id)) throw new Error('Not a chat id');
    return `${CHATS_DIR}/${id}.json`;
  }

  private async readIndex(): Promise<ChatSummary[]> {
    if (this.index) return this.index;
    let index: ChatSummary[] = [];
    try {
      if (await this.fs.stat(`${CHATS_DIR}/index.json`)) {
        const parsed = JSON.parse(await this.fs.readText(`${CHATS_DIR}/index.json`)) as unknown;
        if (Array.isArray(parsed)) index = parsed as ChatSummary[];
      }
    } catch {
      // Unreadable list: the chats themselves are still there; start a new list.
    }
    this.index = index;
    return index;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Saved conversations, most recent first. */
  async list(): Promise<ChatSummary[]> {
    return [...(await this.readIndex())].sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async load(id: string): Promise<SavedChat | undefined> {
    try {
      const chat = JSON.parse(await this.fs.readText(this.file(id))) as SavedChat;
      return Array.isArray(chat.items) ? chat : undefined;
    } catch {
      return undefined;
    }
  }

  /** Writes a conversation (one without a message from the user is not kept). */
  save(
    id: string,
    agent: string,
    snapshot: ChatSnapshot,
    name?: string,
    more?: Pick<SavedChat, 'by' | 'visibility' | 'forkedFrom'>,
  ): Promise<void> {
    return this.serial(async () => {
      if (!snapshot.items.some((i) => i.kind === 'user')) return;
      const index = await this.readIndex();
      const known = index.find((c) => c.id === id);
      const now = new Date().toISOString();
      const chat: SavedChat = {
        version: 1,
        id,
        agent,
        title: name ?? chatTitle(snapshot.items),
        ...(name ? { name } : {}),
        created: known?.created ?? now,
        updated: now,
        items: storableItems(snapshot.items),
        ...(snapshot.input ? { input: snapshot.input } : {}),
        ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
        ...(snapshot.autoApprove ? { autoApprove: true } : {}),
        ...(snapshot.model ? { model: snapshot.model } : {}),
        ...(snapshot.effort ? { effort: snapshot.effort } : {}),
        ...more,
      };
      await this.fs.write(this.file(id), `${JSON.stringify(chat)}\n`);
      const {
        items: _items,
        input: _input,
        sessionId: _sessionId,
        autoApprove: _auto,
        model: _model,
        effort: _effort,
        forkedFrom: _fork,
        version: _v,
        ...summary
      } = chat;
      if (known) {
        if (!name) delete known.name;
        Object.assign(known, summary);
      } else index.push(summary);
      // The oldest conversations make room.
      index.sort((a, b) => b.updated.localeCompare(a.updated));
      for (const old of index.splice(MAX_CHATS)) {
        await this.fs.remove(this.file(old.id)).catch(() => undefined);
      }
      await this.fs.write(`${CHATS_DIR}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const index = await this.readIndex();
      const at = index.findIndex((c) => c.id === id);
      if (at >= 0) index.splice(at, 1);
      await this.fs.remove(this.file(id)).catch(() => undefined);
      await this.fs.write(`${CHATS_DIR}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
    });
  }
}
