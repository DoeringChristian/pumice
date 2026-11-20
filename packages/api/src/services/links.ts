import type { VaultPath } from '@pumice/platform';
import type { LinkRef } from '@pumice/markdown';
import type { Disposable } from '../lifecycle';
import { defineService } from '../service';
import type { IndexedFile } from './metadata';

export interface LinkSuggestion {
  /** Shown in the list. */
  label: string;
  detail?: string;
  /**
   * Text inserted in place of `[[query`, including the closing `]]`. Called once when the
   * suggestion is picked.
   */
  insert: (opts: { embed: boolean; inTable: boolean }) => string;
}

export interface LinkSuggestSource {
  id: string;
  /** Suggestions for the text typed after `[[` (may include `#` or `^`). */
  suggest(query: string, sourcePath: VaultPath): LinkSuggestion[];
}

export interface LinkFormatOptions {
  subpath?: string;
  alias?: string;
  embed?: boolean;
  inTable?: boolean;
}

/**
 * Changes how links to a file are written (suggestions, "copy link", …). Returns the full link
 * text, or undefined for the default `[[Name]]`. Used by the note-IDs plugin for `[[id|Name]]`.
 */
export type LinkFormatter = (file: IndexedFile, opts: LinkFormatOptions) => string | undefined;

export interface LinksApi {
  /**
   * Opens a link target as seen from `sourcePath`. An unresolved target is created as a new
   * note, as in Obsidian.
   */
  openLink(
    target: string,
    opts: { sourcePath: VaultPath; subpath?: string; newTab?: boolean },
  ): Promise<void>;
  /**
   * Link text for a file as written from `sourcePath`: `[[Name]]`, or `[[folder/Name]]` when
   * the name alone is ambiguous (unless a formatter decides otherwise).
   */
  linkTo(path: VaultPath, opts?: LinkFormatOptions): Promise<string>;
  /** Same as `linkTo`, synchronously (the file must be in the index). */
  formatLink(path: VaultPath, opts?: LinkFormatOptions): string;
  /** What a link displays: its alias, else the target's title, else the raw target. */
  displayText(link: Pick<LinkRef, 'target' | 'subpath' | 'alias'>, sourcePath: VaultPath): string;
  registerLinkFormatter(formatter: LinkFormatter): Disposable;
  registerSuggestSource(source: LinkSuggestSource): Disposable;
  suggest(query: string, sourcePath: VaultPath): LinkSuggestion[];
}

export const Links = defineService<LinksApi>('core.links');
