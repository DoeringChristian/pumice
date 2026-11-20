import type { VaultPath } from '@pumice/platform';
import { defineService } from '../service';

/** The assistant, for other plugins (provided by `core.agents`). */
export interface AgentsApi {
  /** Whether an agent can run here at all (desktop). */
  available(): boolean;
  /**
   * Has an agent answer a comment thread: it gets the thread and the commented text, may edit
   * the note, and its answer is posted as a reply in the thread. `agent` is an agent id
   * (`chatgpt`, `claude`, …) or `agent` for the one selected in the chat panel.
   */
  replyToComment(request: { path: VaultPath; threadId: string; agent?: string }): Promise<void>;
}

export const Agents = defineService<AgentsApi>('core.agents');
