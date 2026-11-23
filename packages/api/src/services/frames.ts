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
  /**
   * A frame that is shown (its `figure` element) as one HTML document that needs nothing
   * else: the scripts, styles and pictures beside its file and the data it shows are inside
   * it. For exports. `light`: with the light theme, whatever the app shows. Undefined for an
   * element that is no frame.
   */
  exportHtml(figure: HTMLElement, opts?: { light?: boolean }): Promise<string | undefined>;
  /**
   * What a frame's theme is made of: the names of the app's variables it is given, and the
   * colours of data series in the light and the dark theme. For a page that shows exported
   * frames and tells them when it changes its theme (`{ type: 'pumice-theme', theme }`).
   */
  themeKeys(): { vars: string[]; series: { light: string[]; dark: string[] } };
}

export const Frames = defineService<FramesApi>('core.frames');
