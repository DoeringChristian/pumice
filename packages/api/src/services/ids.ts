import type { VaultPath } from '@pumice/platform';
import { defineService } from '../service';

/**
 * Note IDs (optional plugin `core.ids`): a stable `id` in a note's frontmatter, so `[[id|Name]]`
 * links survive renames and moves even when made outside the app.
 */
export interface NoteIdsApi {
  /** The note's ID, if it has one. */
  idOf(path: VaultPath): string | undefined;
  /** The note with this ID. */
  pathOf(id: string): VaultPath | undefined;
  /** The note's ID, assigning (and writing) a fresh one if it has none. */
  ensureId(path: VaultPath): Promise<string>;
}

export const NoteIds = defineService<NoteIdsApi>('core.ids');
