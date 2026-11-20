import {
  DisposableStore,
  Links,
  ShellService,
  parseEmbedSize,
  toDisposable,
  type CodeBlockRenderer,
  type Disposable,
  type DocumentsApi,
  type EmbedContext,
  type EmbedRenderer,
  type FileMetadata,
  type MarkdownSyntaxApi,
  type MetadataIndexApi,
  type PluginContext,
  type PostProcessor,
  type ReaderApi,
  type RenderContext,
  type VaultApi,
  type VaultPath,
  type WorkspaceApi,
} from '@pumice/api';
import { numberRendered, setEmbedCaption } from './figures';

/** Note embeds deeper than this show a link instead (stops cycles like A embeds B embeds A). */
const MAX_DEPTH = 4;

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
const AUDIO = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm', '3gp'];
const VIDEO = ['mp4', 'mov', 'mkv', 'ogv'];
const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

function mimeFor(ext: string): string {
  if (MIME[ext]) return MIME[ext];
  if (IMAGE.includes(ext)) return `image/${ext}`;
  if (AUDIO.includes(ext)) return `audio/${ext}`;
  if (VIDEO.includes(ext)) return `video/${ext}`;
  return 'application/octet-stream';
}

/** The part of a note a `#Heading` or `#^block` subpath refers to. */
export function sectionOf(
  text: string,
  meta: FileMetadata | undefined,
  subpath: string | undefined,
): string {
  if (!subpath || !meta) {
    return meta?.frontmatterRange
      ? text.slice(meta.frontmatterRange.to).replace(/^\r?\n/, '')
      : text;
  }
  if (subpath.startsWith('^')) {
    const block = meta.blocks.find((b) => b.id === subpath.slice(1));
    return block ? text.slice(block.from, block.to) : '';
  }
  const key = subpath.split('#').filter(Boolean).pop()?.toLowerCase().trim();
  const index = meta.headings.findIndex((h) => h.text.toLowerCase().trim() === key);
  const heading = meta.headings[index];
  if (!heading) return '';
  const next = meta.headings.slice(index + 1).find((h) => h.level <= heading.level);
  return text.slice(heading.from, next ? next.from : text.length);
}

export interface ReaderDeps {
  ctx: PluginContext;
  vault: VaultApi;
  documents: DocumentsApi;
  syntax: MarkdownSyntaxApi;
  index: MetadataIndexApi;
  workspace: WorkspaceApi;
}

export class ReaderImpl implements ReaderApi {
  private readonly embeds: EmbedRenderer[] = [];
  private readonly codeBlocks = new Map<string, CodeBlockRenderer>();
  private readonly postProcessors: PostProcessor[] = [];
  private katex: Promise<typeof import('katex')> | undefined;

  constructor(private readonly deps: ReaderDeps) {
    this.registerBuiltins();
  }

  registerEmbedRenderer(renderer: EmbedRenderer): Disposable {
    this.embeds.push(renderer);
    return toDisposable(() => this.embeds.splice(this.embeds.indexOf(renderer) >>> 0, 1));
  }

  canEmbed(path: VaultPath): boolean {
    const name = path.toLowerCase();
    return this.embeds.some((r) => r.extensions.some((ext) => name.endsWith(`.${ext}`)));
  }

  registerCodeBlockRenderer(renderer: CodeBlockRenderer): Disposable {
    this.codeBlocks.set(renderer.language, renderer);
    return toDisposable(() => {
      if (this.codeBlocks.get(renderer.language) === renderer)
        this.codeBlocks.delete(renderer.language);
    });
  }

  hasCodeBlockRenderer(language: string): boolean {
    return this.codeBlocks.has(language.toLowerCase());
  }

  registerPostProcessor(processor: PostProcessor): Disposable {
    this.postProcessors.push(processor);
    return toDisposable(() =>
      this.postProcessors.splice(this.postProcessors.indexOf(processor) >>> 0, 1),
    );
  }

  async render(
    container: HTMLElement,
    markdown: string,
    opts: { sourcePath: VaultPath; depth?: number; numbered?: boolean },
  ): Promise<Disposable> {
    const store = new DisposableStore();
    const ctx: RenderContext = {
      sourcePath: opts.sourcePath,
      depth: opts.depth ?? 0,
      register: (d) => store.add(d),
    };
    const links = this.deps.ctx.tryUse(Links);
    const tree = this.deps.syntax.parse(markdown);
    container.innerHTML = this.deps.syntax.renderHtml(tree, {
      isResolved: (target) => !!this.deps.index.resolve(target, opts.sourcePath),
      linkText: (link) =>
        links?.displayText(link, opts.sourcePath) ??
        this.deps.index.resolve(link.target, opts.sourcePath)?.file.title ??
        link.target,
    });
    container.classList.add('pm-rendered');
    // Figures, tables and equations of a whole note are numbered.
    const numbering = opts.numbered ? numberRendered(container, markdown) : undefined;

    const tasks: Array<Promise<unknown>> = [];
    for (const el of container.querySelectorAll<HTMLElement>('.pm-math')) {
      tasks.push(this.renderMath(el.dataset.tex ?? '', el.classList.contains('is-display'), el));
    }
    for (const el of container.querySelectorAll<HTMLElement>('.pm-embed')) {
      tasks.push(
        this.renderEmbed({
          target: el.dataset.target ?? '',
          ...(el.dataset.subpath ? { subpath: el.dataset.subpath } : {}),
          ...(el.dataset.alias !== undefined ? { alias: el.dataset.alias } : {}),
          sourcePath: opts.sourcePath,
          depth: ctx.depth,
          container: el,
          // Whenever the embed is drawn (again), its caption goes back under it.
          onDidRender: () => setEmbedCaption(el, numbering?.embed(el)),
        }).then((d) => store.add(d)),
      );
    }
    for (const pre of container.querySelectorAll<HTMLElement>('pre.pm-code-block')) {
      const renderer = this.codeBlocks.get(pre.dataset.lang ?? '');
      if (!renderer) continue;
      const source = pre.textContent ?? '';
      const host = document.createElement('div');
      host.className = `pm-code-render pm-code-render-${renderer.language}`;
      pre.replaceWith(host);
      numbering?.frame(pre, host);
      tasks.push(
        Promise.resolve(renderer.render(source, host, ctx)).catch((e) => {
          host.replaceWith(pre);
          pre.title = `Could not render: ${e instanceof Error ? e.message : String(e)}`;
        }),
      );
    }
    for (const el of container.querySelectorAll<HTMLElement>('.callout[data-callout-fold]')) {
      el.querySelector('.callout-title')?.addEventListener('click', () =>
        el.classList.toggle('is-collapsed'),
      );
    }
    for (const box of container.querySelectorAll<HTMLInputElement>(
      'li[data-task-offset] > input[type=checkbox], li[data-task-offset] > p > input[type=checkbox]',
    )) {
      box.disabled = false;
    }
    const onClick = (e: MouseEvent) => this.onClick(e, opts.sourcePath, container);
    container.addEventListener('click', onClick);
    store.add(() => container.removeEventListener('click', onClick));
    for (const p of this.postProcessors) tasks.push(Promise.resolve(p(container, ctx)));
    await Promise.allSettled(tasks);
    return store;
  }

  async renderMath(tex: string, display: boolean, container: HTMLElement): Promise<void> {
    this.katex ??= import('katex');
    try {
      const katex = (await this.katex).default;
      katex.render(tex, container, {
        displayMode: display,
        throwOnError: false,
        output: 'htmlAndMathml',
      });
      container.classList.add('is-rendered');
    } catch (e) {
      container.textContent = display ? `$$${tex}$$` : `$${tex}$`;
      container.title = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Renders an embed and keeps it current: it is rendered again when its target appears,
   * changes (e.g. a drawing that was just edited) or disappears.
   */
  async renderEmbed(
    ctx: Omit<EmbedContext, 'file' | 'register'> & { onDidRender?: () => void },
  ): Promise<Disposable> {
    const outer = new DisposableStore();
    let inner = new DisposableStore();
    let shown: string | undefined;
    let disposed = false;
    const stamp = () => {
      const r = this.deps.index.resolve(ctx.target, ctx.sourcePath);
      return r ? `${r.file.path}@${r.file.mtime}` : '';
    };
    const update = async () => {
      const next = stamp();
      if (disposed || next === shown) return;
      shown = next;
      inner.dispose();
      inner = new DisposableStore();
      await this.renderEmbedOnce(ctx, inner);
      ctx.onDidRender?.();
    };
    if (!stamp() && !this.deps.index.isReady) {
      // Still scanning the vault at startup: wait before calling the target missing.
      await this.deps.index.ready;
    }
    await update();
    let timer: ReturnType<typeof setTimeout> | undefined;
    outer.add(
      this.deps.index.onDidChange(() => {
        clearTimeout(timer);
        timer = setTimeout(() => void update(), 300);
      }),
    );
    outer.add(
      toDisposable(() => {
        disposed = true;
        clearTimeout(timer);
        inner.dispose();
      }),
    );
    return outer;
  }

  private async renderEmbedOnce(
    ctx: Omit<EmbedContext, 'file' | 'register'>,
    store: DisposableStore,
  ): Promise<void> {
    const resolved = this.deps.index.resolve(ctx.target, ctx.sourcePath);
    const container = ctx.container;
    container.classList.add('pm-embed');
    delete container.dataset.embedType;
    container.replaceChildren();
    if (!resolved) {
      const missing = document.createElement('span');
      missing.className = 'pm-embed-missing';
      missing.textContent = `“${ctx.target}” could not be found.`;
      container.append(missing);
      return;
    }
    const file = resolved.file;
    const name = file.path.toLowerCase();
    let renderer: EmbedRenderer | undefined;
    let length = 0;
    for (const r of this.embeds) {
      for (const ext of r.extensions) {
        if (name.endsWith(`.${ext}`) && ext.length > length) {
          renderer = r;
          length = ext.length;
        }
      }
    }
    if (!renderer) {
      container.append(this.fileLink(file.path, file.title));
      return;
    }
    container.dataset.embedType = renderer.id;
    try {
      await renderer.render({ ...ctx, file, register: (d) => store.add(d) });
    } catch (e) {
      container.textContent = `Could not embed “${file.title}”: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private fileLink(path: VaultPath, title: string): HTMLElement {
    const a = document.createElement('a');
    a.className = 'internal-link';
    a.href = '#';
    a.dataset.target = path;
    a.textContent = title;
    return a;
  }

  private async blobUrl(
    path: VaultPath,
    ext: string,
    register: (d: Disposable) => void,
  ): Promise<string> {
    const bytes = await this.deps.vault.readBinary(path);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(ext) }));
    register(toDisposable(() => URL.revokeObjectURL(url)));
    return url;
  }

  private registerBuiltins(): void {
    this.registerEmbedRenderer({
      id: 'image',
      extensions: IMAGE,
      render: async (ctx) => {
        const img = document.createElement('img');
        img.alt = ctx.alias && !/^\d+(x\d+)?$/.test(ctx.alias) ? ctx.alias : ctx.file!.title;
        const { width, height } = parseEmbedSize(ctx.alias);
        if (width) img.width = width;
        if (height) img.height = height;
        img.src = await this.blobUrl(ctx.file!.path, ctx.file!.extension, (d) => ctx.register(d));
        // Double-click opens the picture on its own (a single click still places the cursor).
        const path = ctx.file!.path;
        img.title = 'Double-click to open';
        img.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.deps.workspace.openFile(path, { newTab: e.metaKey || e.ctrlKey });
        });
        ctx.container.append(img);
      },
    });
    this.registerEmbedRenderer({
      id: 'audio',
      extensions: AUDIO,
      render: async (ctx) => {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = await this.blobUrl(ctx.file!.path, ctx.file!.extension, (d) => ctx.register(d));
        ctx.container.append(audio);
      },
    });
    this.registerEmbedRenderer({
      id: 'video',
      extensions: VIDEO,
      render: async (ctx) => {
        const video = document.createElement('video');
        video.controls = true;
        const { width } = parseEmbedSize(ctx.alias);
        if (width) video.width = width;
        video.src = await this.blobUrl(ctx.file!.path, ctx.file!.extension, (d) => ctx.register(d));
        ctx.container.append(video);
      },
    });
    this.registerEmbedRenderer({
      id: 'pdf',
      extensions: ['pdf'],
      render: async (ctx) => {
        const frame = document.createElement('iframe');
        frame.className = 'pm-embed-pdf';
        frame.src = await this.blobUrl(ctx.file!.path, 'pdf', (d) => ctx.register(d));
        ctx.container.append(frame);
      },
    });
    this.registerEmbedRenderer({
      id: 'note',
      extensions: ['md'],
      render: async (ctx) => {
        const file = ctx.file!;
        const header = document.createElement('div');
        header.className = 'pm-embed-title';
        header.append(
          this.fileLink(
            file.path,
            ctx.subpath ? `${file.title} › ${ctx.subpath.replace(/^\^/, '')}` : file.title,
          ),
        );
        ctx.container.append(header);
        if (ctx.depth >= MAX_DEPTH) return;
        const body = document.createElement('div');
        body.className = 'pm-embed-body';
        ctx.container.append(body);
        const refresh = async () => {
          const text = await this.deps.documents.read(file.path);
          const meta = this.deps.index.getFile(file.path)?.meta;
          const disposable = await this.render(body, sectionOf(text, meta, ctx.subpath), {
            sourcePath: file.path,
            depth: ctx.depth + 1,
          });
          ctx.register(disposable);
        };
        await refresh();
        let timer: ReturnType<typeof setTimeout> | undefined;
        ctx.register(
          this.deps.index.onDidChange((paths) => {
            if (!paths.includes(file.path)) return;
            clearTimeout(timer);
            timer = setTimeout(() => void refresh(), 100);
          }),
        );
        ctx.register(toDisposable(() => clearTimeout(timer)));
      },
    });
    this.registerCodeBlockRenderer({
      language: 'mermaid',
      render: async (source, container) => {
        const mermaid = (await import('mermaid')).default;
        const dark =
          document.documentElement.dataset.theme === 'dark' ||
          (document.documentElement.dataset.theme !== 'light' &&
            matchMedia('(prefers-color-scheme: dark)').matches);
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
          securityLevel: 'strict',
        });
        const id = `pm-mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, source);
        container.innerHTML = svg;
      },
    });
  }

  private onClick(e: MouseEvent, sourcePath: VaultPath, root: HTMLElement): void {
    const target = e.target as HTMLElement;
    const box = target.closest<HTMLInputElement>('input[type=checkbox]');
    const task = box?.closest<HTMLElement>('li[data-task-offset]');
    if (box && task && root.contains(task)) {
      void this.toggleTask(sourcePath, Number(task.dataset.taskOffset), box);
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a');
    if (!link || !root.contains(link)) return;
    if (link.classList.contains('internal-link')) {
      e.preventDefault();
      // Nested embeds resolve relative to the embedded note.
      const owner = link
        .closest<HTMLElement>('.pm-embed-body')
        ?.parentElement?.querySelector<HTMLElement>('.pm-embed-title a');
      const from = owner && owner !== link ? (owner.dataset.target ?? sourcePath) : sourcePath;
      void this.openLink(
        link.dataset.target ?? '',
        link.dataset.subpath,
        from,
        e.metaKey || e.ctrlKey,
      );
    } else if (link.classList.contains('tag')) {
      e.preventDefault();
      void this.deps.ctx.commands
        .execute('search.open', `tag:#${link.dataset.tag}`)
        .catch(() => undefined);
    } else if (link.classList.contains('external-link')) {
      e.preventDefault();
      const href = link.getAttribute('href') ?? '';
      if (/^(https?|mailto):/i.test(href))
        void this.deps.ctx.tryUse(ShellService)?.openExternal(href);
    }
  }

  private async openLink(
    target: string,
    subpath: string | undefined,
    sourcePath: VaultPath,
    newTab: boolean,
  ): Promise<void> {
    const links = this.deps.ctx.tryUse(Links);
    if (links) {
      await links.openLink(target, { sourcePath, newTab, ...(subpath ? { subpath } : {}) });
      return;
    }
    const resolved = this.deps.index.resolve(target, sourcePath);
    if (resolved)
      await this.deps.workspace.openFile(resolved.file.path, {
        newTab,
        state: subpath ? { subpath } : {},
      });
  }

  private async toggleTask(path: VaultPath, offset: number, box: HTMLInputElement): Promise<void> {
    const handle = await this.deps.documents.open(path);
    try {
      const text = handle.text();
      const m = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/.exec(text.slice(offset));
      if (!m || handle.codec.id !== 'markdown') return;
      const at = offset + m[1]!.length;
      const ytext = handle.doc.getText('content');
      handle.doc.transact(() => {
        ytext.delete(at, 1);
        ytext.insert(at, m[2] === ' ' ? 'x' : ' ');
      });
      box.checked = m[2] === ' ';
    } finally {
      handle.dispose();
    }
  }
}
