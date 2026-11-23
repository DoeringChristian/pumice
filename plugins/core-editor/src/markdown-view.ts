import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { sectionFolding } from './folding';
import { texHighlighting } from './tex';
import { commonmarkLanguage, markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder,
  rectangularSelection,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import {
  basename,
  dirname,
  frontmatterBounds,
  joinPath,
  markdownText,
  type DisposableStore,
  type DocumentHandle,
  type Disposable,
  type DocumentsApi,
  type EditorToolbarAction,
  type MarkdownSyntaxApi,
  type MetadataIndexApi,
  type ReaderApi,
  type VaultApi,
  type ViewContext,
  type ViewInstance,
  type ViewState,
  type WorkspaceApi,
} from '@pumice/api';
import { createIcon } from '@pumice/ui';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { completionExtension } from './completion';
import { livePreview, previewDeps, sourceModeStyling } from './live-preview';

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '650' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--link)' },
  { tag: tags.url, color: 'var(--text-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)' },
  {
    tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName],
    color: 'var(--text-faint)',
  },
  { tag: tags.quote, color: 'var(--text-muted)' },
  { tag: tags.keyword, color: '#a34fb0' },
  { tag: [tags.string, tags.special(tags.string)], color: '#4c8a3f' },
  { tag: [tags.number, tags.bool, tags.atom], color: '#b0662a' },
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.propertyName], color: '#2f6fb0' },
  { tag: tags.typeName, color: '#2a8a86' },
  { tag: tags.meta, color: 'var(--text-faint)' },
]);

export interface EditorShared {
  workspace: WorkspaceApi;
  documents: DocumentsApi;
  vault: VaultApi;
  syntax: MarkdownSyntaxApi;
  reader: () => ReaderApi | undefined;
  index: () => MetadataIndexApi | undefined;
  /** Extensions contributed by plugins (`Editor.registerExtension`). */
  contributed: () => Extension[];
  sourceMode: () => boolean;
  openExternal: (url: string) => void;
  /** The right-click menu of an embedded picture, video or frame. */
  embedMenu: (
    view: EditorView,
    host: HTMLElement,
    path: string,
    at: { x: number; y: number },
  ) => void;
  /** The menu of a rendered block (a frame block). */
  blockMenu: (
    view: EditorView,
    block: { from: number; to: number },
    at: { x: number; y: number },
  ) => void;
  onActiveChange: (view: MarkdownView | undefined) => void;
  /** Toolbar actions for touch devices, sorted. */
  toolbarActions: () => EditorToolbarAction[];
  /** Starts a comment on a range of the note (absent without the comments plugin). */
  comment?: (view: EditorView, range: { from: number; to: number }) => void;
  /** Whether `\\left(` gets its `\\right)` as it is typed. */
  closeLeft: () => boolean;
  /** Whether to show the touch toolbar (phone/tablet layouts). */
  touch: () => boolean;
}

const isPlainText = (path: string) => /\.(tex|txt)$/i.test(path);

/** A tab showing one markdown file. */
export class MarkdownView implements ViewInstance {
  readonly editor: EditorView;
  private handle: DocumentHandle | undefined;
  private handleStore: DisposableStore | undefined;
  private readonly titleInput: HTMLInputElement;
  readonly contributedCompartment = new Compartment();
  readonly modeCompartment = new Compartment();
  private disposed = false;
  /** Set when a new note is opened: focus goes to the title so it can be named right away. */
  private pendingRename = false;
  private readonly page: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly readingEl: HTMLElement;
  private reading = false;
  private readingRender: Disposable | undefined;
  private readingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ctx: ViewContext,
    private readonly shared: EditorShared,
    private readonly newStore: () => DisposableStore,
  ) {
    const root = ctx.container;
    root.classList.add('pm-markdown-view');
    const scroller = document.createElement('div');
    scroller.className = 'pm-markdown-scroller';
    const page = document.createElement('div');
    page.className = 'pm-markdown-page';
    this.titleInput = document.createElement('input');
    this.titleInput.className = 'pm-inline-title';
    this.titleInput.spellcheck = false;
    this.titleInput.setAttribute('aria-label', 'Note title');
    this.titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.focusBody();
      } else if (e.key === 'Escape') {
        this.titleInput.value = this.handle ? stem(this.handle.path) : '';
        this.focusBody();
      }
    });
    this.titleInput.addEventListener('blur', () => void this.renameFromTitle());
    page.append(this.titleInput);
    scroller.append(page);
    root.append(scroller);
    this.page = page;

    this.editor = new EditorView({ parent: page });
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'pm-editor-toolbar';
    this.toolbar.setAttribute('role', 'toolbar');
    this.toolbar.setAttribute('aria-label', 'Formatting');
    this.toolbar.hidden = true;
    // Keep the editor focused (and the keyboard up) while tapping toolbar buttons.
    this.toolbar.addEventListener('mousedown', (e) => e.preventDefault());
    root.append(this.toolbar);
    this.editor.contentDOM.addEventListener('focus', () => this.showToolbar(true));
    this.editor.contentDOM.addEventListener('blur', () =>
      setTimeout(() => this.showToolbar(this.editor.hasFocus), 100),
    );
    this.readingEl = document.createElement('div');
    this.readingEl.className = 'pm-reading-view';
    this.readingEl.hidden = true;
    this.readingEl.tabIndex = -1;
    page.append(this.readingEl);
    this.editor.contentDOM.addEventListener('focus', () => shared.onActiveChange(this));
    this.editor.dom.addEventListener('mousedown', (e) => this.onMouseDown(e));
    // A file dragged into the empty space below the text is dropped at the end of the note.
    const below = (e: DragEvent) => {
      if (this.reading || this.editor.dom.contains(e.target as Node)) return;
      const content = this.editor.contentDOM.getBoundingClientRect();
      if (e.clientY < content.bottom) return;
      const passed = new DragEvent(e.type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: e.dataTransfer,
        // The end of the last line.
        clientX: content.right - 2,
        clientY: content.bottom - 2,
      });
      if (!this.editor.contentDOM.dispatchEvent(passed)) e.preventDefault();
    };
    // A click beside or below the text puts the cursor on that line, or at the end of the note
    // (the text cursor is shown there, so it has to mean something).
    const beside = (e: MouseEvent) => {
      if (this.reading || e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target !== this.page && target !== this.page.parentElement) return;
      const content = this.editor.contentDOM.getBoundingClientRect();
      if (e.clientY < content.top) return;
      e.preventDefault();
      const { doc } = this.editor.state;
      const x = Math.max(content.left + 1, Math.min(e.clientX, content.right - 1));
      const pos =
        e.clientY >= content.bottom
          ? doc.length
          : (this.editor.posAtCoords({ x, y: e.clientY }, false) ?? doc.length);
      // To the right of a line: its end.
      const anchor = e.clientX > content.right ? doc.lineAt(pos).to : pos;
      this.editor.dispatch({ selection: { anchor } });
      this.editor.focus();
    };
    queueMicrotask(() => {
      const scroller = this.page.parentElement;
      scroller?.addEventListener('dragover', below);
      scroller?.addEventListener('drop', below);
      scroller?.addEventListener('mousedown', beside);
    });
  }

  get path(): string | undefined {
    return this.handle?.path;
  }

  async setState(state: ViewState): Promise<void> {
    if (state.rename) this.pendingRename = true;
    if (state.mode === 'reading' || state.mode === 'editing')
      this.setReading(state.mode === 'reading');
    if (!state.path) return;
    if (this.handle?.path === state.path) {
      if (typeof state.subpath === 'string') this.revealSubpath(state.subpath);
      if (typeof state.offset === 'number') this.revealOffset(state.offset);
      return;
    }
    this.restoreToken++;
    const handle = await this.shared.documents.open(state.path);
    if (this.disposed) {
      handle.dispose();
      return;
    }
    this.releaseHandle();
    this.handle = handle;
    const store = (this.handleStore = this.newStore());
    store.add(handle);
    store.add(handle.onDidRename((path) => this.showPath(path)));
    store.add(handle.onDidDelete(() => this.shared.workspace.closeFile(handle.path)));
    this.showPath(handle.path);
    // CodeMirror refocuses a focused view after setState; a new note wants the title focused.
    if (this.pendingRename) this.editor.contentDOM.blur();
    this.editor.setState(this.createState(handle));
    if (this.reading) this.renderReading();
    if (typeof state.subpath === 'string') this.revealSubpath(state.subpath);
    else if (typeof state.offset === 'number') this.revealOffset(state.offset);
    else this.restorePlace(state);
  }

  private restoreToken = 0;

  /**
   * Puts the cursor and the scroll position back where they were (going back or forward, or
   * reopening the app); a note opened fresh starts at its top.
   */
  private restorePlace(state: ViewState): void {
    const scroller = this.page.parentElement;
    if (typeof state.cursor === 'number') {
      const pos = Math.max(0, Math.min(state.cursor, this.editor.state.doc.length));
      this.editor.dispatch({ selection: { anchor: pos } });
    }
    if (!scroller) return;
    const top = typeof state.scroll === 'number' ? Math.max(0, state.scroll) : 0;
    scroller.scrollTop = top;
    if (!top) return;
    // The note is still being laid out (embeds, images): keep at it until the place is
    // reachable, unless the user scrolls or opens something else first.
    const token = ++this.restoreToken;
    const started = performance.now();
    const stop = () => {
      this.restoreToken++;
      scroller.removeEventListener('wheel', stop);
      scroller.removeEventListener('pointerdown', stop);
      scroller.removeEventListener('keydown', stop);
    };
    scroller.addEventListener('wheel', stop, { passive: true });
    scroller.addEventListener('pointerdown', stop);
    scroller.addEventListener('keydown', stop);
    const again = () => {
      if (token !== this.restoreToken || this.disposed) return;
      if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top;
      if (performance.now() - started < 1500) requestAnimationFrame(again);
      else stop();
    };
    requestAnimationFrame(again);
  }

  revealOffset(offset: number): void {
    if (this.reading) this.setReading(false);
    const pos = Math.max(0, Math.min(offset, this.editor.state.doc.length));
    this.editor.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    this.editor.focus();
  }

  getState(): ViewState {
    return {
      path: this.handle?.path,
      mode: this.reading ? 'reading' : 'editing',
      scroll: Math.round(this.page.parentElement?.scrollTop ?? 0),
      cursor: this.editor.state.selection.main.head,
    };
  }

  get isReading(): boolean {
    return this.reading;
  }

  setReading(reading: boolean): void {
    if (reading === this.reading) return;
    this.reading = reading;
    this.editor.dom.hidden = reading;
    this.readingEl.hidden = !reading;
    this.ctx.container.classList.toggle('pm-is-reading', reading);
    if (reading) this.renderReading();
    else {
      this.readingRender?.dispose();
      this.readingRender = undefined;
      this.readingEl.replaceChildren();
      this.editor.focus();
    }
  }

  private renderReading(): void {
    clearTimeout(this.readingTimer);
    const reader = this.shared.reader();
    const path = this.handle?.path;
    if (!this.reading || path === undefined) return;
    if (!reader) {
      this.readingEl.textContent = this.editor.state.doc.toString();
      return;
    }
    const text = this.editor.state.doc.toString();
    const scroll = this.page.parentElement?.scrollTop ?? 0;
    void reader.render(this.readingEl, text, { sourcePath: path, numbered: true }).then((d) => {
      this.readingRender?.dispose();
      this.readingRender = d;
      if (this.page.parentElement) this.page.parentElement.scrollTop = scroll;
    });
  }

  /** Scrolls to `Heading`, `H1#H2` or `^block` in this note. */
  revealSubpath(subpath: string): void {
    const path = this.handle?.path;
    const target =
      path !== undefined ? this.shared.index()?.resolveSubpath(path, subpath) : undefined;
    if (this.reading) {
      const key = subpath.replace(/^\^/, '');
      const el = subpath.startsWith('^')
        ? this.readingEl.querySelector(`[data-block-id="${CSS.escape(key)}"]`)?.parentElement
        : [...this.readingEl.querySelectorAll<HTMLElement>('[data-heading]')].find(
            (h) => h.dataset.heading?.toLowerCase() === key.split('#').pop()?.toLowerCase(),
          );
      el?.scrollIntoView({ block: 'start' });
      return;
    }
    if (!target) return;
    const pos = Math.min(target.from, this.editor.state.doc.length);
    this.editor.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }),
    });
  }

  focus(): void {
    if (this.reading) {
      this.readingEl.focus();
      return;
    }
    if (this.pendingRename) {
      this.pendingRename = false;
      this.titleInput.focus();
      this.titleInput.select();
      return;
    }
    this.focusBody();
  }

  private showToolbar(show: boolean): void {
    const visible = show && this.shared.touch() && !this.reading;
    if (visible && this.toolbar.hidden) {
      this.toolbar.replaceChildren(
        ...this.shared.toolbarActions().map((action) => {
          const b = document.createElement('button');
          b.className = 'pm-editor-toolbar-button';
          b.title = action.title;
          b.setAttribute('aria-label', action.title);
          const icon = /^[a-z-]+$/.test(action.icon) ? createIcon(action.icon, 18) : null;
          if (icon) b.append(icon);
          else b.textContent = action.icon;
          b.addEventListener('click', () => action.run(this.editor));
          return b;
        }),
      );
    }
    this.toolbar.hidden = !visible;
  }

  /** Focuses the editor with the cursor in the body, not in the (rendered) frontmatter. */
  private focusBody(): void {
    const fm = frontmatterBounds(this.editor.state.doc.toString().slice(0, 4096));
    if (fm && this.editor.state.selection.main.head < fm.to) {
      this.editor.dispatch({
        selection: { anchor: Math.min(fm.to, this.editor.state.doc.length) },
      });
    }
    this.editor.focus();
  }

  /** Words in the document, for the status bar. */
  wordCount(): number {
    const text = this.editor.state.doc.toString().replace(/^---\n[\s\S]*?\n---\n/, '');
    return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  }

  reconfigureContributed(): void {
    this.editor.dispatch({
      effects: this.contributedCompartment.reconfigure(this.shared.contributed()),
    });
  }

  setSourceMode(wanted: boolean): void {
    const source = wanted || isPlainText(this.handle?.path ?? '');
    this.editor.dispatch({
      effects: this.modeCompartment.reconfigure(source ? sourceModeStyling : livePreview),
    });
    this.ctx.container.classList.toggle('pm-source-mode', source);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.readingTimer);
    this.readingRender?.dispose();
    this.releaseHandle();
    this.editor.destroy();
    this.shared.onActiveChange(undefined);
  }

  private releaseHandle(): void {
    this.handleStore?.dispose();
    this.handleStore = undefined;
    this.handle = undefined;
  }

  private showPath(path: string): void {
    const title = stem(path);
    this.ctx.setTitle(title);
    this.ctx.setFile(path);
    if (document.activeElement !== this.titleInput) this.titleInput.value = title;
  }

  private createState(handle: DocumentHandle): EditorState {
    const shared = this.shared;
    const ytext = markdownText(handle.doc);
    const undoManager = new Y.UndoManager(ytext);
    const text = ytext.toString();
    // Start below the frontmatter, so it shows as properties rather than raw YAML.
    const anchor = Math.min(frontmatterBounds(text.slice(0, 4096))?.to ?? 0, text.length);
    return EditorState.create({
      doc: text,
      selection: { anchor },
      extensions: [
        yCollab(ytext, (handle.awareness as Parameters<typeof yCollab>[1]) ?? null, {
          undoManager,
        }),
        EditorState.readOnly.of(handle.readOnly),
        keymap.of([
          ...yUndoManagerKeymap,
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...markdownKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        yamlFrontmatter({
          content: markdown({
            base: commonmarkLanguage,
            extensions: this.shared.syntax.lezerExtensions(),
            codeLanguages: languages,
            addKeymap: false,
          }),
        }),
        previewDeps.of({
          syntax: this.shared.syntax,
          get reader() {
            return shared.reader();
          },
          sourcePath: () => this.handle?.path,
          embedMenu: (v, host, at) => {
            const path = this.handle?.path;
            if (path !== undefined) shared.embedMenu(v, host, path, at);
          },
          blockMenu: (v, block, at) => shared.blockMenu(v, block, at),
          ...(shared.comment ? { comment: (v, range) => shared.comment!(v, range) } : {}),
        }),
        syntaxHighlighting(highlightStyle),
        EditorView.lineWrapping,
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        closeBrackets(),
        completionExtension({ closeLeft: () => this.shared.closeLeft() }),
        sectionFolding(),
        texHighlighting,
        search({ top: true }),
        highlightSelectionMatches(),
        placeholder('Start writing…'),
        EditorView.contentAttributes.of({
          spellcheck: 'true',
          autocorrect: 'on',
          autocapitalize: 'sentences',
        }),
        // A file that is not a note (a .tex preamble, a .txt) is shown as it is written.
        this.modeCompartment.of(
          this.shared.sourceMode() || isPlainText(handle.path) ? sourceModeStyling : livePreview,
        ),
        this.contributedCompartment.of(this.shared.contributed()),
        EditorView.updateListener.of((u) => {
          if (u.docChanged || u.focusChanged) this.shared.onActiveChange(this);
          if (u.docChanged && this.reading) {
            clearTimeout(this.readingTimer);
            this.readingTimer = setTimeout(() => this.renderReading(), 250);
          }
        }),
      ],
    });
  }

  private onMouseDown(e: MouseEvent): void {
    const link = (e.target as HTMLElement).closest<HTMLElement>('.cm-pm-link');
    const href = link?.dataset.href;
    if (!href || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      this.shared.openExternal(href);
    } else if (this.handle) {
      // Relative markdown link to a vault file.
      const target = joinPath(dirname(this.handle.path), decodeURIComponent(href));
      void this.shared.workspace.openFile(target, { newTab: e.shiftKey });
    }
  }

  private async renameFromTitle(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    const title = this.titleInput.value.trim();
    const current = stem(handle.path);
    if (!title || title === current) {
      this.titleInput.value = current;
      return;
    }
    if (/[\\/:*?"<>|#^[\]]/.test(title)) {
      this.shared.workspace.notify(
        'A title cannot contain any of these characters: \\ / : * ? " < > | # ^ [ ]',
        {
          kind: 'warning',
        },
      );
      this.titleInput.value = current;
      return;
    }
    const name = basename(handle.path);
    const ext = name.slice(name.indexOf('.') >= 0 ? name.lastIndexOf('.') : name.length);
    const target = joinPath(dirname(handle.path), `${title}${ext}`);
    try {
      await this.shared.vault.rename(handle.path, target);
    } catch (e) {
      this.shared.workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' });
      this.titleInput.value = current;
    }
  }
}

function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
