import type { BibEntry, CitationStyle } from '@pumice/markdown';
import type { VaultPath } from '@pumice/platform';
import type { Event } from '../lifecycle';
import { defineService } from '../service';

/**
 * The bibliography of a note (provided by `core.bibliography`): the entries of the BibTeX
 * files its `bibliography` property names, or of the vault's default file.
 */
export interface BibliographyApi {
  /**
   * The entries a note can cite, by key, as far as they are read: reading goes on behind,
   * and `onDidChange` fires when there is more (or a file changed).
   */
  entries(note: VaultPath): ReadonlyMap<string, BibEntry>;
  /** Resolves when the note's bibliography files have been read. */
  ready(note: VaultPath): Promise<void>;
  /** The file an entry of a note's bibliography is in. */
  fileOf(note: VaultPath, key: string): VaultPath | undefined;
  /** How citations read: `[1]`, or "Doe et al. (2020)". */
  style(): CitationStyle;
  readonly onDidChange: Event<void>;
}

export const Bibliography = defineService<BibliographyApi>('core.bibliography');
