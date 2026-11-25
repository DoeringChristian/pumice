import type { VaultPath } from '@pumice/platform';
import { defineService } from '../service';

/**
 * Drawings as text, for what cannot look at them (provided by `core.excalidraw`): what is in
 * one, and changes to it as a few plain operations. Both work on the text of the file, so
 * whoever asks reads and writes it the way it reads and writes any other.
 */
export interface DrawingsApi {
  /** Whether the file at this path is a drawing. */
  isDrawing(path: VaultPath): boolean;
  /** The elements of a drawing, a line each (id, kind, place, size, text, what arrows join). */
  describe(path: VaultPath, text: string): string;
  /**
   * The text of the drawing with the operations applied (`{op: 'add' | 'update' | 'delete', …}`;
   * see the tool the agents plugin offers), and what was done. Without `text`: a new drawing.
   * Throws if an operation cannot be done; nothing is changed then. `operations` may be empty
   * when there is something to arrange.
   */
  edit(
    path: VaultPath,
    text: string | undefined,
    operations: readonly unknown[],
    /** `arrange`: lay out what the arrows join as a flowchart, downwards or to the right. */
    options?: { arrange?: 'down' | 'right' },
  ): { text: string; summary: string };
  /**
   * The drawing as it looks, for what can look at pictures: a PNG as a `data:` address, on
   * white, no larger than a model takes in at once.
   */
  picture(path: VaultPath, text: string): Promise<string>;
}

export const Drawings = defineService<DrawingsApi>('core.excalidraw');
