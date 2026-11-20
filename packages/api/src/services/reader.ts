import type { VaultPath } from '@pumice/platform';
import type { Disposable, DisposableLike } from '../lifecycle';
import { defineService } from '../service';
import type { IndexedFile } from './metadata';

export interface RenderContext {
  /** Note the content belongs to (links resolve relative to it). */
  sourcePath: VaultPath;
  /** Embed nesting depth; renderers stop at a limit to avoid cycles. */
  depth: number;
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
}

export interface EmbedRenderer {
  id: string;
  /** File name endings this renderer handles (e.g. `png`, `excalidraw.md`); longest wins. */
  extensions: string[];
  render(ctx: EmbedContext): void | Promise<void>;
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
    opts: { sourcePath: VaultPath; depth?: number },
  ): Promise<Disposable>;
  /** Renders TeX with KaTeX (loaded on first use). */
  renderMath(tex: string, display: boolean, container: HTMLElement): Promise<void>;
  /** Renders an embed (`![[target]]`) into `container`, as the reading view does. */
  /** Renders an embed and re-renders it when its target changes; `onDidRender` fires each time. */
  renderEmbed(
    ctx: Omit<EmbedContext, 'file' | 'register'> & { onDidRender?: () => void },
  ): Promise<Disposable>;
  registerEmbedRenderer(renderer: EmbedRenderer): Disposable;
  registerCodeBlockRenderer(renderer: CodeBlockRenderer): Disposable;
  /** Whether fenced blocks in this language have a renderer (e.g. `mermaid`). */
  hasCodeBlockRenderer(language: string): boolean;
  registerPostProcessor(processor: PostProcessor): Disposable;
}

export const Reader = defineService<ReaderApi>('core.reader');
