import type { VaultPath } from '@pumice/platform';
import { defineService } from '../service';

/** Frames (HTML shown in notes), for other plugins (provided by `core.frames`). */
export interface FramesApi {
  /**
   * What to write into a note to show these vault files through a frame: for a file whose
   * type a frame offers to show (asking which, if several do), or for a frame itself (asking
   * which files it should show). Resolves to the text, to `null` when the user cancelled, and
   * to `undefined` when frames have nothing to do with these files.
   */
  insertionFor(paths: VaultPath[], sourcePath: VaultPath): Promise<string | null | undefined>;
}

export const Frames = defineService<FramesApi>('core.frames');
