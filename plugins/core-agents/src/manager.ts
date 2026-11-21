import type { ContentBlock } from '@agentclientprotocol/sdk';
import { Emitter } from '@pumice/api';
import { chatTitle, type SavedChat } from './chats';
import type { ChatSession, TranscriptItem } from './session';

/**
 * The chats that are open at once. Each keeps its agent running whether or not the panel
 * shows it; messages for a busy chat wait in its queue.
 */

/** A message waiting for its chat to be free. */
export interface Queued {
  message: string;
  blocks: ContentBlock[];
  label: string | undefined;
  /** Called when the message is handed to the agent. */
  started?: () => void;
  /** Called with what the agent produced once this message's turn is over. */
  done?: (produced: TranscriptItem[]) => void;
  failed?: (error: unknown) => void;
}

export interface OpenChat {
  readonly session: ChatSession;
  /** A name the user gave it (otherwise it is called after its first message). */
  name: string | undefined;
  readonly queue: Queued[];
  /** It finished something while another chat was on screen. */
  unread: boolean;
}

/** What a chat's row shows. */
export type ChatState = 'starting' | 'working' | 'permission' | 'unread' | 'idle' | 'error';

export const chatName = (chat: OpenChat): string => chat.name ?? chatTitle(chat.session.items);

/** A name as it is typed after `@` in a comment: `Literature review` → `literature-review`. */
export const mentionOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

export function chatState(chat: OpenChat): ChatState {
  const s = chat.session;
  if (s.items.some((i) => i.kind === 'permission' && !i.chosen)) return 'permission';
  if (s.status === 'working') return 'working';
  if (s.status === 'starting') return 'starting';
  if (s.status === 'error' || s.status === 'closed') return 'error';
  return chat.unread ? 'unread' : 'idle';
}

export class ChatManager {
  private readonly chats: OpenChat[] = [];
  private readonly subs = new Map<OpenChat, { dispose(): void }>();
  private readonly handing = new WeakSet<OpenChat>();
  private shown: string | undefined;
  private readonly changed = new Emitter<void>();
  /** A chat was opened, closed, renamed, or its state changed. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly create: (agentId: string, saved?: SavedChat) => ChatSession,
    /** Whether the user is looking at the chat panel. */
    private readonly visible: () => boolean = () => true,
  ) {}

  /** Open chats, in the order they were opened. */
  get open(): readonly OpenChat[] {
    return this.chats;
  }

  get(chatId: string | undefined): OpenChat | undefined {
    return chatId ? this.chats.find((c) => c.session.chatId === chatId) : undefined;
  }

  /** The chat the panel shows. */
  get active(): OpenChat | undefined {
    return this.get(this.shown);
  }

  show(chatId: string | undefined): void {
    this.shown = chatId;
    const chat = this.get(chatId);
    if (chat) chat.unread = false;
    this.changed.fire();
  }

  /** Opens a new chat with an agent, or a saved one (which is not opened twice). */
  start(agentId: string, saved?: SavedChat): OpenChat {
    const existing = this.get(saved?.id);
    if (existing) return existing;
    const session = this.create(agentId, saved);
    const chat: OpenChat = { session, name: saved?.name, queue: [], unread: false };
    this.chats.push(chat);
    let last = session.status;
    this.subs.set(
      chat,
      session.onDidChange(() => {
        if (last === 'working' && session.status !== 'working') {
          if (this.shown !== session.chatId || !this.visible()) chat.unread = true;
        }
        const moved = last !== session.status;
        last = session.status;
        this.flush(chat);
        if (session.status === 'closed' || session.status === 'error') this.fail(chat, false);
        // The transcript changes far more often than what the list shows.
        if (moved || chat.unread) this.changed.fire();
      }),
    );
    void session.start();
    this.changed.fire();
    return chat;
  }

  close(chatId: string): void {
    const at = this.chats.findIndex((c) => c.session.chatId === chatId);
    if (at < 0) return;
    const [chat] = this.chats.splice(at, 1);
    this.subs.get(chat!)?.dispose();
    this.subs.delete(chat!);
    this.fail(chat!);
    chat!.session.dispose();
    if (this.shown === chatId) this.shown = undefined;
    this.changed.fire();
  }

  rename(chatId: string, name: string): void {
    const chat = this.get(chatId);
    if (!chat) return;
    chat.name = name.trim() || undefined;
    this.changed.fire();
  }

  /** Chats that want attention while another one is on screen. */
  waiting(): number {
    return this.chats.filter(
      (c) =>
        c.session.chatId !== this.shown && ['permission', 'unread', 'error'].includes(chatState(c)),
    ).length;
  }

  /** The open chat a comment's `@name` means, most recently opened first. */
  byMention(name: string): OpenChat | undefined {
    const wanted = mentionOf(name);
    if (!wanted) return undefined;
    const newest = [...this.chats].reverse();
    return (
      newest.find((c) => mentionOf(chatName(c)) === wanted) ??
      newest.find((c) => c.session.config.id === wanted)
    );
  }

  /**
   * Sends a message to a chat. While its agent is working the message waits its turn; with
   * `interrupt` the agent is stopped and the message goes next.
   */
  send(chat: OpenChat, item: Queued, interrupt = false): void {
    if (interrupt && chat.session.status === 'working') {
      chat.queue.unshift(item);
      chat.session.cancel();
    } else chat.queue.push(item);
    this.changed.fire();
    this.flush(chat);
  }

  /** Like `send`, resolving with what the agent produced in answer. */
  ask(chat: OpenChat, item: Omit<Queued, 'done' | 'failed'>): Promise<TranscriptItem[]> {
    return new Promise((done, failed) => this.send(chat, { ...item, done, failed }));
  }

  unqueue(chat: OpenChat, index: number): void {
    const [item] = chat.queue.splice(index, 1);
    item?.failed?.(new Error('The message was withdrawn.'));
    this.changed.fire();
  }

  private flush(chat: OpenChat): void {
    const s = chat.session;
    if (s.status !== 'ready' || this.handing.has(chat)) return;
    const next = chat.queue.shift();
    if (!next) return;
    // Starting a turn reports changes before the agent counts as busy: one message at a time.
    this.handing.add(chat);
    try {
      const before = s.items.length;
      next.started?.();
      s.prompt(next.message, next.blocks, next.label).then(
        () => next.done?.(s.items.slice(before)),
        (e: unknown) => next.failed?.(e),
      );
    } finally {
      this.handing.delete(chat);
    }
    this.changed.fire();
  }

  /** Nothing more will be answered: whoever waits for an answer is told. */
  private fail(chat: OpenChat, all = true): void {
    // What the user typed stays for when the agent is back (after signing in, say).
    const gone = chat.queue.filter((item) => all || item.failed);
    for (const item of gone) {
      chat.queue.splice(chat.queue.indexOf(item), 1);
      item.failed?.(new Error('The chat stopped before it got to this.'));
    }
  }

  dispose(): void {
    for (const chat of [...this.chats]) this.close(chat.session.chatId);
  }
}
