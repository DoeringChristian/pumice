import type { VaultPath } from '@pumice/platform';
import type { Event } from '../lifecycle';
import { defineService } from '../service';

/** Where a comment thread points: the quoted text, its context and last offset (docs/plan/09). */
export interface CommentAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}

export interface CommentEntry {
  id: string;
  author: string;
  body: string;
  /** ISO timestamps. */
  created: string;
  edited?: string;
}

export interface CommentThread {
  id: string;
  anchor: CommentAnchor;
  resolved: boolean;
  comments: CommentEntry[];
}

/** A thread with its current position in the note (null: the quoted text is gone). */
export interface LocatedThread extends CommentThread {
  range: { from: number; to: number } | null;
}

export interface CommentsApi {
  /** Threads of a note in document order (detached ones last). */
  threads(path: VaultPath): Promise<LocatedThread[]>;
  /** Starts a thread on `from`..`to` of the note's current text. */
  addThread(
    path: VaultPath,
    range: { from: number; to: number },
    body: string,
    author?: string,
  ): Promise<CommentThread>;
  reply(path: VaultPath, threadId: string, body: string, author?: string): Promise<CommentEntry>;
  editComment(path: VaultPath, threadId: string, commentId: string, body: string): Promise<void>;
  deleteComment(path: VaultPath, threadId: string, commentId: string): Promise<void>;
  setResolved(path: VaultPath, threadId: string, resolved: boolean): Promise<void>;
  deleteThread(path: VaultPath, threadId: string): Promise<void>;
  /** Fires with the note whose comments changed. */
  readonly onDidChange: Event<VaultPath>;
}

/**
 * Who a comment addresses with an `@mention` of an agent: `@agent` (the default one) or an
 * agent by name (`@chatgpt`, `@claude`, `@codex`, `@gemini`). Undefined when it mentions none.
 */
export function agentMention(body: string): string | undefined {
  const m = /(^|[\s(])@(agent|assistant|chatgpt|claude|codex|gemini)\b/i.exec(body);
  return m ? m[2]!.toLowerCase() : undefined;
}

export const Comments = defineService<CommentsApi>('core.comments');
