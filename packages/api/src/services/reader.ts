import type { VaultPath } from '@pumice/platform';
import type { Disposable, DisposableLike } from '../lifecycle';
import { defineService } from '../service';
import type { IndexedFile } from './metadata';

export interface RenderContext {
  /** Note the content belongs to (links resolve relative to it). */
  sourcePath: VaultPath;
  /** Embed nesting depth; renderers stop at a limit to avoid cycles. */
  depth: number;
  /** A whole note is rendered (not a part of one, like a slide or what a note embeds). */
  whole?: boolean;
  /** Ties a resource to the lifetime of the rendered element. */
  register(disposable: DisposableLike): void;
}

export interface EmbedContext extends RenderContext {
  target: string;
  subpath?: string;
  /** Text after `|` (size like `300x200`, or alt text). */
  alias?: string;
  /** The resolved file, if any. */
  file?: IndexedFile;
  container: HTMLElement;
  /** How large what is embedded is, where that is known before it is loaded (see `measure`). */
  size?: MediaSize;
}

/** The size something has by itself, in pixels. */
export interface MediaSize {
  width: number;
  height: number;
}

export interface EmbedRenderer {
  id: string;
  /** File name endings this renderer handles (e.g. `png`, `excalidraw.md`); longest wins. */
  extensions: string[];
  render(ctx: EmbedContext): void | Promise<void>;
  /**
   * Optional, and quick: how large a file is, told without loading all of it, so that its room
   * is kept while it loads. It comes to `render` as `ctx.size`. `read` gives part of the file,
   * or undefined where the platform cannot. Undefined when it cannot be told: nothing is kept.
   */
  measure?(
    file: { path: VaultPath; extension: string },
    read: (offset: number, length: number) => Promise<Uint8Array | undefined>,
  ): Promise<MediaSize | undefined>;
}

export interface CodeBlockRenderer {
  /** Fence language, e.g. `mermaid`. */
  language: string;
  render(source: string, container: HTMLElement, ctx: RenderContext): void | Promise<void>;
}

export type PostProcessor = (root: HTMLElement, ctx: RenderContext) => void | Promise<void>;

export interface ReaderApi {
  /** Renders markdown into `container` (replacing its content). Dispose to release embeds. */
  render(
    container: HTMLElement,
    markdown: string,
    opts: {
      sourcePath: VaultPath;
      depth?: number;
      /** The markdown is a whole note: number its figures, tables and equations. */
      numbered?: boolean;
    },
  ): Promise<Disposable>;
  /**
   * Renders TeX with KaTeX (loaded on first use), with the commands of the vault's LaTeX
   * preamble and, given `sourcePath`, of that note's own. Drawn again by itself when a
   * preamble changes.
   */
  renderMath(
    tex: string,
    display: boolean,
    container: HTMLElement,
    opts?: { sourcePath?: VaultPath },
  ): Promise<void>;
  /** Whether videos start again when they end (a setting, on unless switched off). */
  loopVideos(): boolean;
  /** Renders an embed (`![[target]]`) into `container`, as the reading view does. */
  /** Renders an embed and re-renders it when its target changes; `onDidRender` fires each time. */
  renderEmbed(
    ctx: Omit<EmbedContext, 'file' | 'register'> & { onDidRender?: () => void },
  ): Promise<Disposable>;
  registerEmbedRenderer(renderer: EmbedRenderer): Disposable;
  /** Whether `![[file]]` shows this file (a picture, a note, a PDF, …) rather than a link. */
  canEmbed(path: VaultPath): boolean;
  registerCodeBlockRenderer(renderer: CodeBlockRenderer): Disposable;
  /** Whether fenced blocks in this language have a renderer (e.g. `mermaid`). */
  hasCodeBlockRenderer(language: string): boolean;
  registerPostProcessor(processor: PostProcessor): Disposable;
}

export const Reader = defineService<ReaderApi>('core.reader');
