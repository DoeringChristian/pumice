import {
  DisposableStore,
  Links,
  ShellService,
  embedCaption,
  parseEmbedSize,
  sizeEmbed,
  toDisposable,
  type CodeBlockRenderer,
  type Disposable,
  type DocumentsApi,
  type EmbedContext,
  type EmbedRenderer,
  type MediaSize,
  type Remembered,
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
import { PreambleStore } from './preamble';
import { mediaSize, placeholder } from './media-header';
import { createIcon, createVideoPlayer } from '@pumice/ui';
import { numberRendered, setEmbedCaption, splitFigureLines } from './figures';
import { showLightbox } from './lightbox';
import { renderTex } from './math';

/** Note embeds deeper than this show a link instead (stops cycles like A embeds B embeds A). */
const MAX_DEPTH = 4;

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'];
const AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', '3gp'];
// As in the viewer (a .webm is shown as a video).
const VIDEO = ['mp4', 'm4v', 'mov', 'mkv', 'ogv', 'webm'];
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
  sizes: Remembered<MediaSize & { of?: string }>;
  ctx: PluginContext;
  vault: VaultApi;
  documents: DocumentsApi;
  syntax: MarkdownSyntaxApi;
  index: MetadataIndexApi;
  workspace: WorkspaceApi;
}

/**
 * The vault's LaTeX preamble, unless the settings name another file: a note whose `tex` code
 * blocks hold the definitions.
 */
export const DEFAULT_PREAMBLE = 'texpreamble.md';
/**
 * Other names it is found under when that note does not exist: as a plain .tex file, and
 * where it was kept before.
 */
export const OTHER_PREAMBLES = ['texpreamble.tex', 'preamble.md', 'preamble.tex'];

export class ReaderImpl implements ReaderApi {
  private readonly embeds: EmbedRenderer[] = [];
  private readonly codeBlocks = new Map<string, CodeBlockRenderer>();
  private readonly postProcessors: PostProcessor[] = [];
  private katex: Promise<typeof import('katex')> | undefined;

  constructor(private readonly deps: ReaderDeps) {
    this.registerBuiltins();
    this.watchPreambles();
    this.watchMedia();
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
      ...(opts.numbered && !opts.depth ? { whole: true } : {}),
      register: (d) => store.add(d),
    };
    const links = this.deps.ctx.tryUse(Links);
    const tree = this.deps.syntax.parse(markdown);
    const linkText = (link: { target: string; subpath?: string; alias?: string }) =>
      links?.displayText(link, opts.sourcePath) ??
      this.deps.index.resolve(link.target, opts.sourcePath)?.file.title ??
      link.target;
    container.innerHTML = this.deps.syntax.renderHtml(tree, {
      isResolved: (target) => !!this.deps.index.resolve(target, opts.sourcePath),
      linkText,
    });
    container.classList.add('pm-rendered');
    // A line of figures is a row of its own, as it is where the note is written.
    splitFigureLines(container);
    // Figures, tables and equations of a whole note are numbered.
    const numbering = opts.numbered ? numberRendered(container, markdown) : undefined;

    const tasks: Array<Promise<unknown>> = [];
    for (const el of container.querySelectorAll<HTMLElement>('.pm-math')) {
      tasks.push(
        this.renderMath(el.dataset.tex ?? '', el.classList.contains('is-display'), el, {
          sourcePath: opts.sourcePath,
        }),
      );
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
          onDidRender: () =>
            setEmbedCaption(el, numbering?.embed(el), (link) =>
              // A label of this note reads as it is numbered right now (the index may lag).
              !link.target && link.subpath?.startsWith('^')
                ? (numbering?.reference(link.subpath.slice(1)) ?? linkText(link))
                : linkText(link),
            ),
        }).then((d) => store.add(d)),
      );
    }
    for (const pre of container.querySelectorAll<HTMLElement>('pre.pm-code-block')) {
      const renderer = this.codeBlocks.get(pre.dataset.lang ?? '');
      if (!renderer) {
        // Plain code: its language in the corner, and a button to copy it.
        if (!pre.querySelector(':scope > .pm-code-tools')) {
          const code = pre.textContent ?? '';
          const tools = document.createElement('span');
          tools.className = 'pm-code-tools';
          const label = document.createElement('span');
          label.className = 'pm-code-lang';
          label.textContent = pre.dataset.lang || 'text';
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'pm-copy-button';
          copy.title = 'Copy';
          copy.setAttribute('aria-label', 'Copy');
          copy.append(createIcon('copy', 13));
          copy.addEventListener('click', (e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(code).then(() => {
              copy.replaceChildren(createIcon('check', 13));
              setTimeout(() => copy.replaceChildren(createIcon('copy', 13)), 1200);
            });
          });
          tools.append(label, copy);
          pre.append(tools);
        }
        continue;
      }
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

  /** Formulas on screen, to draw them again when a preamble changes. */
  private readonly drawn = new Map<
    HTMLElement,
    { tex: string; display: boolean; path?: VaultPath }
  >();
  private readonly preambles = new PreambleStore({
    path: () => this.preamblePath(),
    exists: (path) => !!this.deps.vault.get(path),
    read: async (path) => this.deps.documents.peek(path) ?? (await this.deps.vault.read(path)),
    property: (note) => this.deps.index.getFile(note)?.meta?.frontmatter?.preamble,
    resolve: (target, from) => this.deps.index.resolve(target, from)?.file.path,
    katex: async () => (await (this.katex ??= import('katex'))).default,
    report: (path, errors) => {
      const text = `LaTeX preamble (${path}): ${errors.join('; ')}`;
      // Said once for the same mistakes, not at every formula.
      if (this.reported.has(text)) return;
      this.reported.add(text);
      this.deps.workspace.notify(text, { kind: 'warning', timeout: 8000 });
    },
  });
  private readonly reported = new Set<string>();

  loopVideos(): boolean {
    return this.deps.ctx.settings.get('loopVideos', true);
  }

  /** Where the vault's LaTeX preamble is kept. */
  preamblePath(): VaultPath {
    const set = this.deps.ctx.settings.get('preamble', '').trim();
    if (set) return set;
    const { vault } = this.deps;
    if (vault.get(DEFAULT_PREAMBLE)) return DEFAULT_PREAMBLE;
    return OTHER_PREAMBLES.find((path) => vault.get(path)) ?? DEFAULT_PREAMBLE;
  }

  /** Reads the preambles again and draws every formula on screen with them. */
  refreshMath(): void {
    this.preambles.reset();
    this.reported.clear();
    this.redrawMath();
  }

  private redrawMath(): void {
    for (const [el, formula] of [...this.drawn]) {
      if (!el.isConnected) this.drawn.delete(el);
      else
        void this.renderMath(formula.tex, formula.display, el, {
          ...(formula.path !== undefined ? { sourcePath: formula.path } : {}),
        });
    }
  }

  private watchPreambles(): void {
    const { vault, index, ctx } = this.deps;
    ctx.register(
      vault.onDidChange((changes) => {
        const paths = changes.flatMap((c) =>
          c.type === 'delete'
            ? [c.path]
            : c.type === 'rename'
              ? [c.oldPath, c.entry.path]
              : [c.entry.path],
        );
        if (paths.map((p) => this.preambles.fileChanged(p)).some(Boolean)) {
          this.reported.clear();
          this.redrawMath();
        }
      }),
    );
    ctx.register(
      index.onDidChange((paths) => {
        if (paths.map((p) => this.preambles.noteChanged(p)).some(Boolean)) this.redrawMath();
      }),
    );
  }

  async renderMath(
    tex: string,
    display: boolean,
    container: HTMLElement,
    opts: { sourcePath?: VaultPath } = {},
  ): Promise<void> {
    this.katex ??= import('katex');
    try {
      const katex = (await this.katex).default;
      const macros = await this.preambles.for(opts.sourcePath);
      // Elements that are gone make room.
      if (this.drawn.size > 400)
        for (const el of [...this.drawn.keys()]) if (!el.isConnected) this.drawn.delete(el);
      this.drawn.set(container, {
        tex,
        display,
        ...(opts.sourcePath !== undefined ? { path: opts.sourcePath } : {}),
      });
      // A formula with a mistake is drawn as far as it is right, the wrong part in red.
      const problem = renderTex(katex, tex, display, container, macros);
      container.classList.add('is-rendered');
      container.classList.toggle('has-error', !!problem);
      if (problem) container.title = problem;
      else container.removeAttribute('title');
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
    const container = ctx.container;
    container.classList.add('pm-embed');
    // Whatever it is, it takes the size written in the note.
    sizeEmbed(container, parseEmbedSize(ctx.alias));
    delete container.dataset.embedType;
    container.replaceChildren();
    if (/^https?:\/\//i.test(ctx.target)) {
      container.dataset.embedType = 'image';
      return this.picture(ctx, {
        key: ctx.target,
        name: ctx.target,
        size: this.deps.sizes.get(ctx.target),
        url: () => ctx.target,
        open: () => this.deps.ctx.tryUse(ShellService)?.openExternal(ctx.target),
      });
    }
    const resolved = this.deps.index.resolve(ctx.target, ctx.sourcePath);
    if (!resolved) {
      const missing = document.createElement('span');
      missing.className = 'pm-embed-missing';
      missing.textContent = `“${ctx.target}” could not be found.`;
      container.append(missing);
      return;
    }
    const file = resolved.file;
    const renderer = this.rendererFor(file.path);
    if (!renderer) {
      container.append(this.fileLink(file.path, file.title));
      return;
    }
    container.dataset.embedType = renderer.id;
    try {
      const size = await this.sizeOf(file.path, renderer);
      await renderer.render({
        ...ctx,
        file,
        ...(size ? { size } : {}),
        register: (d) => store.add(d),
      });
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

  /**
   * The files that are shown, as addresses the page can load: read once and kept while in use
   * and for a while after. A picture that scrolls out of a note and back in is the same
   * picture to the browser (the same address), which then has it at hand; read anew each time
   * it was decoded anew each time, and a long note with large figures scrolled in jerks.
   */
  private readonly media = new Map<
    VaultPath,
    { url: Promise<string>; bytes: number; users: number; used: number }
  >();
  /** How much is kept that nothing shows at the moment. */
  private static readonly KEEP_UNUSED = 256 * 1024 * 1024;

  private rendererFor(path: VaultPath): EmbedRenderer | undefined {
    const name = path.toLowerCase();
    let found: EmbedRenderer | undefined;
    let length = 0;
    for (const r of this.embeds)
      for (const ext of r.extensions)
        if (name.endsWith(`.${ext}`) && ext.length > length) {
          found = r;
          length = ext.length;
        }
    return found;
  }

  /** Files that do not say how large they are: not asked again until they change. */
  private readonly unmeasured = new Set<VaultPath>();
  /** What tells one state of a file from another; undefined for what is not of the vault. */
  private version(path: VaultPath): string | undefined {
    const file = this.deps.vault.get(path);
    return file?.kind === 'file' ? `${file.mtime}:${file.size}` : undefined;
  }
  /** The size that was learned, of the file as it is now (it may have changed while closed). */
  private known(path: VaultPath): MediaSize | undefined {
    const found = this.deps.sizes.get(path);
    return found && found.of === this.version(path) ? found : undefined;
  }
  private learn(path: VaultPath, size: MediaSize): void {
    const of = this.version(path);
    this.deps.sizes.learn(path, { ...size, ...(of ? { of } : {}) });
  }

  private readonly measuring = new Map<VaultPath, Promise<MediaSize | undefined>>();

  /** How large a file is, if its kind of embed can tell (quickly: it does not hold it up). */
  private async sizeOf(path: VaultPath, renderer: EmbedRenderer): Promise<MediaSize | undefined> {
    const known = this.known(path);
    if (known || !renderer.measure || this.unmeasured.has(path)) return known;
    return Promise.race([
      this.measure(path, renderer),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 150)),
    ]);
  }

  private measure(path: VaultPath, renderer: EmbedRenderer): Promise<MediaSize | undefined> {
    let job = this.measuring.get(path);
    if (!job) {
      const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const of = this.version(path);
      job = renderer.measure!({ path, extension }, (offset, length) =>
        this.deps.vault.readRange(path, offset, length),
      )
        .then((size) => {
          // (Not if it changed meanwhile.)
          if (size && of === this.version(path)) this.learn(path, size);
          else if (!size) this.unmeasured.add(path);
          return size;
        })
        .catch(() => undefined)
        .finally(() => this.measuring.delete(path));
      this.measuring.set(path, job);
    }
    return job;
  }

  /** Looks at the files of the vault ahead of time, a few at once, so that notes open in place. */
  async measureAll(stopped: () => boolean): Promise<void> {
    if (this.measuringAll) return;
    this.measuringAll = true;
    try {
      await this.measureNew(stopped);
    } finally {
      this.measuringAll = false;
    }
  }
  private measuringAll = false;
  private async measureNew(stopped: () => boolean): Promise<void> {
    const { vault } = this.deps;
    const todo = vault.files().flatMap(({ path }) => {
      const renderer = this.rendererFor(path);
      return renderer?.measure && !this.known(path) && !this.unmeasured.has(path)
        ? [{ path, renderer }]
        : [];
    });
    if (!todo.length) return;
    // Where only whole files can be read it is not worth it.
    const first = await vault.readRange(todo[0]!.path, 0, 1).catch(() => new Uint8Array());
    if (!first) return;
    const next = async () => {
      for (let item = todo.shift(); item && !stopped(); item = todo.shift())
        if (vault.get(item.path)) await this.measure(item.path, item.renderer);
    };
    await Promise.all([next(), next(), next(), next()]);
  }

  /**
   * A picture, of the vault or from the web: its room is kept (as large as it is or was, or in
   * the proportions written in the note) until it is there. `key`: what its size is known by.
   */
  private async picture(
    ctx: { alias?: string; container: HTMLElement },
    of: {
      key: string;
      name: string;
      size: MediaSize | undefined;
      url(): string | Promise<string>;
      /** Cmd/Ctrl-click; a click alone enlarges it. */
      open(): unknown;
    },
  ): Promise<void> {
    const img = document.createElement('img');
    img.className = 'pm-embed-media pm-zoomable';
    // Decoded beside the page, not in its way: a large picture does not hold up scrolling.
    img.decoding = 'async';
    img.alt = embedCaption(ctx.alias) ?? of.name;
    const { w, h } = parseEmbedSize(ctx.alias);
    const size =
      of.size ?? (w && h && !w.unit && !h.unit ? { width: w.value, height: h.value } : undefined);
    if (size) img.src = placeholder(size);
    ctx.container.append(img);
    img.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) of.open();
      else showLightbox(img.src, img.alt);
    });
    const url = await of.url();
    img.addEventListener('load', () => {
      if (img.src === url && img.naturalWidth)
        this.learn(of.key, { width: img.naturalWidth, height: img.naturalHeight });
    });
    img.addEventListener('error', () => {
      if (img.src !== url) return;
      const missing = document.createElement('span');
      missing.className = 'pm-embed-missing';
      missing.textContent = `“${img.alt}” could not be shown.`;
      img.replaceWith(missing);
    });
    img.src = url;
  }

  private dropMedia(path: VaultPath): void {
    const entry = this.media.get(path);
    if (!entry) return;
    this.media.delete(path);
    void entry.url.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
  }

  /** Lets go of what nothing shows, oldest first, once it is more than is worth keeping. */
  private trimMedia(): void {
    const unused = [...this.media.entries()]
      .filter(([, e]) => e.users === 0)
      .sort((x, y) => y[1].used - x[1].used);
    let kept = 0;
    for (const [path, entry] of unused) {
      kept += entry.bytes;
      if (kept > ReaderImpl.KEEP_UNUSED) this.dropMedia(path);
    }
  }

  private watchMedia(): void {
    this.deps.vault.onDidChange((changes) => {
      // A file that changed is read again by what shows it next (an embed draws itself anew
      // when its file changes); what still shows the old one keeps its address until then.
      for (const c of changes) {
        const paths =
          c.type === 'delete' ? [c.path] : c.type === 'rename' ? [c.oldPath] : [c.entry.path];
        for (const path of paths) {
          this.deps.sizes.forget(path);
          this.unmeasured.delete(path);
          const entry = this.media.get(path);
          if (!entry) continue;
          if (entry.users === 0) this.dropMedia(path);
          else this.media.delete(path);
        }
      }
    });
  }

  private async blobUrl(
    path: VaultPath,
    ext: string,
    register: (d: Disposable) => void,
  ): Promise<string> {
    let entry = this.media.get(path);
    if (!entry) {
      const fresh = {
        url: this.deps.vault.readBinary(path).then((bytes) => {
          fresh.bytes = bytes.byteLength;
          return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(ext) }));
        }),
        bytes: 0,
        users: 0,
        used: 0,
      };
      entry = fresh;
      this.media.set(path, entry);
      // One that could not be read is tried again next time.
      entry.url.catch(() => this.media.get(path) === fresh && this.media.delete(path));
    }
    const mine = entry;
    mine.users++;
    mine.used = Date.now();
    register(
      toDisposable(() => {
        mine.users--;
        mine.used = Date.now();
        // No longer the file's (it changed meanwhile) and no longer shown: gone.
        if (mine.users === 0 && this.media.get(path) !== mine)
          void mine.url.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
        else this.trimMedia();
      }),
    );
    return mine.url;
  }

  private registerBuiltins(): void {
    this.registerEmbedRenderer({
      id: 'image',
      extensions: IMAGE,
      measure: (file, read) => mediaSize(file.extension, read),
      render: async (ctx) => {
        const { path, extension, title } = ctx.file!;
        await this.picture(ctx, {
          key: path,
          name: title,
          size: ctx.size,
          url: () => this.blobUrl(path, extension, (d) => ctx.register(d)),
          open: () => this.deps.workspace.openFile(path, { newTab: true }),
        });
      },
    });
    this.registerEmbedRenderer({
      id: 'audio',
      extensions: AUDIO,
      render: async (ctx) => {
        const audio = document.createElement('audio');
        audio.className = 'pm-embed-media';
        audio.controls = true;
        audio.src = await this.blobUrl(ctx.file!.path, ctx.file!.extension, (d) => ctx.register(d));
        ctx.container.append(audio);
      },
    });
    this.registerEmbedRenderer({
      id: 'video',
      extensions: VIDEO,
      measure: (file, read) => mediaSize(file.extension, read),
      render: async (ctx) => {
        // The app's own controls, the same as in the viewer.
        const path = ctx.file!.path;
        const { dom, video } = createVideoPlayer(undefined, {
          // As for a picture: a click enlarges it; with Cmd/Ctrl it opens in a tab.
          onClick: (shown, e) => {
            if (e.metaKey || e.ctrlKey) void this.deps.workspace.openFile(path, { newTab: true });
            else showLightbox(shown.currentSrc || shown.src, ctx.file!.title, shown);
          },
        });
        video.classList.add('pm-embed-media');
        video.loop = this.loopVideos();
        // Its room, until it is known how large it is.
        const { size } = ctx;
        // (As its still picture, which gives it its size as the video will.)
        if (size) video.poster = placeholder(size);
        video.addEventListener('loadedmetadata', () => {
          if (size) video.removeAttribute('poster');
          this.learn(path, {
            width: video.videoWidth,
            height: video.videoHeight,
          });
        });
        ctx.container.append(dom);
        video.src = await this.blobUrl(path, ctx.file!.extension, (d) => ctx.register(d));
      },
    });
    this.registerEmbedRenderer({
      id: 'pdf',
      extensions: ['pdf'],
      render: async (ctx) => {
        const frame = document.createElement('iframe');
        frame.className = 'pm-embed-pdf pm-embed-media';
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
