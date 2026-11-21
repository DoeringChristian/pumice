import type { VaultPath } from '@pumice/platform';
import type { Disposable } from '../lifecycle';
import { defineService } from '../service';

export interface AgentMention {
  /** What is typed after `@`. */
  mention: string;
  label: string;
  detail?: string;
}

/** The assistant, for other plugins (provided by `core.agents`). */
export interface AgentsApi {
  /** Whether an agent can run here at all (desktop). */
  available(): boolean;
  /**
   * Has an agent answer a comment thread: it gets the thread and the commented text, may edit
   * the note, and its answer is posted as a reply in the thread. `agent` is what was written
   * after `@`: a chat's name, an agent id (`chatgpt`, `claude`, …), or `agent` for the chat
   * that fits best (the one that answered the thread before, wrote the text, or is open). A
   * busy chat answers when it is done with what it is doing.
   */
  replyToComment(request: { path: VaultPath; threadId: string; agent?: string }): Promise<void>;
  /** Who a comment can address with `@…`: `agent`, the open chats by name, the agents. */
  mentions(): AgentMention[];
  /** What the chat that would answer is called, to show before the comment is sent. */
  recipient(request: {
    path: VaultPath;
    threadId?: string;
    range?: { from: number; to: number } | null;
    mention?: string;
  }): Promise<string | undefined>;
  /** Whether a chat has answered in this thread: replies to it go to that chat again. */
  answers(threadId: string): boolean;
  /**
   * Adds standing guidance for every agent (how a feature of the app is used). The text is
   * read when a conversation starts.
   */
  registerGuidance(text: () => string): Disposable;
}

export const Agents = defineService<AgentsApi>('core.agents');
