import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { SessionStatus, SlashCommand, TranscriptItem } from './session';

/**
 * The agent chats of a served folder, kept by its server (docs/plan/11): one WebSocket per
 * window and vault, `/agents?vault=…&token=…`, JSON text frames both ways.
 */

/** A transcript item as it goes over the wire (nothing to call). */
export type WireItem = TranscriptItem extends infer T
  ? T extends unknown
    ? Omit<T, 'respond'>
    : never
  : never;

export interface WireAgent {
  id: string;
  name: string;
  setupHint?: string;
}

/** A chat as the list shows it. */
export interface WireChat {
  id: string;
  agent: string;
  title: string;
  name?: string;
  created: string;
  updated: string;
  by?: { id: string; name: string };
  /** Open: among the chats of every window (running, or to be started by its next prompt). */
  open: boolean;
  status: SessionStatus;
  /** A question of the agent's waits for an answer. */
  waiting: boolean;
  /** Prompts waiting for their turn. */
  queued: number;
}

/** What a followed chat's header and input need. */
export interface WireState {
  status: SessionStatus;
  modes: Array<{ id: string; name: string }>;
  currentMode?: string;
  models: Array<{ id: string; name: string }>;
  currentModel?: string;
  efforts: Array<{ id: string; name: string }>;
  currentEffort?: string;
  commands: SlashCommand[];
  loginOptions: Array<{ id: string; name: string }>;
  autoApprove: boolean;
}

export type ServerMessage =
  | { t: 'hello'; agents: WireAgent[]; root: string; user: { id: string; name: string } }
  | { t: 'chats'; chats: WireChat[] }
  /** A followed chat, whole (on follow, and when its agent starts again). */
  | { t: 'chat'; id: string; items: WireItem[]; state: WireState }
  /** A followed chat's items that are new or changed, and its state if it changed. */
  | { t: 'update'; id: string; items: WireItem[]; state?: WireState }
  /** A prompt's turn is over (or it was not taken: `error`). */
  | { t: 'done'; req: number; error?: string }
  | { t: 'error'; message: string };

/**
 * `guidance`: what the window's plugins tell agents about the app (Frames, ...), given to the
 * agent with the first message of a conversation (the server's own plugins do not run there).
 */
export type ClientMessage =
  | { t: 'follow'; id: string; guidance?: string }
  | { t: 'unfollow'; id: string }
  /** A new chat (`id` made by the window); `fork`: starting with what was said in that one. */
  | { t: 'new'; id: string; agent: string; fork?: string; name?: string; guidance?: string }
  /** Opens an earlier chat again: its agent starts and picks it up. */
  | { t: 'open'; id: string; guidance?: string }
  | {
      t: 'prompt';
      id: string;
      req: number;
      text: string;
      blocks: ContentBlock[];
      label?: string;
    }
  | { t: 'cancel'; id: string }
  | { t: 'answer'; id: string; item: number; option: string | null }
  | { t: 'mode'; id: string; mode: string }
  | { t: 'model'; id: string; model: string }
  | { t: 'effort'; id: string; effort: string }
  | { t: 'auth'; id: string; method: string }
  | { t: 'auto'; id: string; on: boolean }
  | { t: 'rename'; id: string; name: string }
  /** Ends the chat's agent; the chat stays among the earlier ones. */
  | { t: 'end'; id: string }
  | { t: 'delete'; id: string };

export const wireItem = (item: TranscriptItem): WireItem => {
  if (item.kind !== 'permission') return item;
  const { respond: _respond, ...rest } = item;
  return rest;
};

/** A chat's id, as `newChatId` makes them (nothing else: ids name files in `.pumice/chats`). */
export const CHAT_ID = /^[a-z0-9]{1,16}-[a-z0-9]{1,16}$/;
