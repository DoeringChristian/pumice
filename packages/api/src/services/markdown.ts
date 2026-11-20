import type { Root } from 'mdast';
import type { MarkdownConfig } from '@lezer/markdown';
import type { Extension as MicromarkExtension } from 'micromark-util-types';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { FileMetadata, RenderOptions } from '@pumice/markdown';
import type { Disposable, Event } from '../lifecycle';
import { defineService } from '../service';

/**
 * A syntax extension. Provide both halves (Lezer for the editor, micromark + mdast for the
 * reading view and index) so the editor and the rest of the app agree on the document.
 * Registering only `lezer` is fine for editor-only decorations.
 */
export interface MarkdownSyntaxExtension {
  name: string;
  lezer?: MarkdownConfig | MarkdownConfig[];
  micromark?: MicromarkExtension;
  mdast?: FromMarkdownExtension;
  /** Post-parse mdast transform. */
  transform?: (tree: Root) => void;
}

export interface MarkdownSyntaxApi {
  register(extension: MarkdownSyntaxExtension): Disposable;
  /** Lezer configs of the full dialect plus registered extensions (for the editor). */
  lezerExtensions(): MarkdownConfig[];
  parse(text: string): Root;
  /** Links, tags, headings, blocks, frontmatter, … of a markdown text. */
  extract(text: string): FileMetadata;
  /** Sanitized HTML. */
  renderHtml(tree: Root, opts?: RenderOptions): string;
  /** True when plugins added micromark/mdast syntax (parsing must then happen in this realm). */
  readonly hasCustomSyntax: boolean;
  readonly onDidChange: Event<void>;
}

export const MarkdownSyntax = defineService<MarkdownSyntaxApi>('core.markdown');
