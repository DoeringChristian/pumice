import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { sectionFolding } from './folding';
import { listEditing } from './lists';
import { texHighlighting } from './tex';
import {
  commonmarkLanguage,
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdown,
} from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { findAndReplace } from './search-panel';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
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
  type LinksApi,
  referableItems,
  drawnFor,
} from '@pumice/api';
import { createIcon } from '@pumice/ui';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { completionExtension } from './completion';
import { revealItem, lineField, livePreview, previewDeps, sourceModeStyling } from './live-preview';

export const highlightStyle = HighlightStyle.define([
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
  /** Links between notes, where there are any (how a link reads, opening one). */
  links: () => LinksApi | undefined;
  /** Runs a command of the app. */
  run: (command: string, arg?: unknown) => void;
  onActiveChange: (view: MarkdownView | undefined) => void;
  /** Toolbar actions for touch devices, sorted. */
  toolbarActions: () => EditorToolbarAction[];
  /** Extensions for the text fields inside a note (`Editor.registerFieldExtension`). */
  fieldExtensions: () => Extension[];
  /** Extensions for the field a caption is written in (`Editor.registerCaptionExtension`). */
  captionExtensions: (note: EditorView) => Extension[];
  /** Starts a comment on a range of the note (absent without the comments plugin). */
  comment?: (view: EditorView, range: { from: number; to: number }) => void;
  /** Switches every note between its source and the drawn text. */
  setSourceMode: (source: boolean) => void;
  /** Whether `\\left(` gets its `\\right)` as it is typed. */
  closeLeft: () => boolean;
  /** Whether to show the touch toolbar (phone/tablet layouts). */
  touch: () => boolean;
}

/** A tab showing one markdown file. */
export class MarkdownView implements ViewInstance {
  readonly editor: EditorView;
  private handle: DocumentHandle | undefined;
  private handleStore: DisposableStore | undefined;
  private readonly titleInput: HTMLInputElement;
  readonly contributedCompartment = new Compartment();
  readonly modeCompartment = new Compartment();
  /** Whether the note can be changed (not while it is read). */
  private readonly readCompartment = new Compartment();
  private disposed = false;
  /** Set when a new note is opened: focus goes to the title so it can be named right away. */
  private pendingRename = false;
  private readonly page: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly modeSwitch: HTMLElement;
  private reading = false;

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
    // With key bindings of the editor's for text fields (vim mode), the name is written with
    // them: in an editor of its own, in the name's place.
    this.titleInput.addEventListener('focus', () => this.titleInEditor());
    page.append(this.titleInput);
    scroller.append(page);
    root.append(scroller);
    this.page = page;
    // How wide the text is: what a size without a unit is a share of (`![[x.png|350]]` is
    // half of the line), here and in what is embedded in the note.
    const textWidth = new ResizeObserver(() => {
      const style = getComputedStyle(page);
      const width =
        page.clientWidth -
        parseFloat(style.paddingLeft || '0') -
        parseFloat(style.paddingRight || '0');
      if (width > 0) page.style.setProperty('--pm-text-w', `${width}px`);
    });
    textWidth.observe(page);

    this.editor = new EditorView({ parent: page });
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'pm-editor-toolbar';
    this.toolbar.setAttribute('role', 'toolbar');
    this.toolbar.setAttribute('aria-label', 'Formatting');
    this.toolbar.hidden = true;
    // Keep the editor focused (and the keyboard up) while tapping toolbar buttons.
    this.toolbar.addEventListener('mousedown', (e) => e.preventDefault());
    root.append(this.toolbar);
    // How the note is shown: to write (what it stands for is drawn), to read (nothing can be
    // changed), or as its source.
    this.modeSwitch = document.createElement('div');
    this.modeSwitch.className = 'pm-mode-switch';
    this.modeSwitch.setAttribute('role', 'radiogroup');
    this.modeSwitch.setAttribute('aria-label', 'How the note is shown');
    for (const [mode, icon, title] of [
      ['edit', 'pencil', 'Edit: write, with everything drawn'],
      ['read', 'book-open', 'Read: nothing can be changed'],
      ['source', 'code', 'Source: the text as it is written'],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pm-mode-switch-button';
      b.dataset.mode = mode;
      b.title = title;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', title);
      b.append(createIcon(icon, 14));
      // The cursor stays where it is.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.setMode(mode));
      this.modeSwitch.append(b);
    }
    root.append(this.modeSwitch);
    this.showMode();
    this.editor.contentDOM.addEventListener('focus', () => this.showToolbar(true));
    this.editor.contentDOM.addEventListener('blur', () =>
      setTimeout(() => this.showToolbar(this.editor.hasFocus), 100),
    );
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
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target !== this.page && target !== this.page.parentElement) return;
      const content = this.editor.contentDOM.getBoundingClientRect();
      if (e.clientY < content.top) return;
      if (e.clientY < content.bottom) {
        // Beside a line: as if the press were at that line's nearest end. The editor takes it
        // from there, so a selection can be drawn from the margin (a drag from the first letter
        // of a line starts a little to its left as often as not), with all that a press in
        // the text itself does: a word on a double click, more with Shift.
        e.preventDefault();
        if (!this.reading) this.editor.focus();
        this.editor.contentDOM.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            buttons: e.buttons,
            detail: e.detail,
            clientX: Math.max(content.left + 1, Math.min(e.clientX, content.right - 1)),
            clientY: e.clientY,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
          }),
        );
        return;
      }
      if (this.reading) return;
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

  /** How the note is shown: `edit` (live preview), `read` (no editing) or `source`. */
  get mode(): 'edit' | 'read' | 'source' {
    return this.reading ? 'read' : this.shared.sourceMode() ? 'source' : 'edit';
  }

  setMode(mode: 'edit' | 'read' | 'source'): void {
    // Source or drawn is the same for every note; reading is this note's own.
    if (mode !== 'read') this.shared.setSourceMode(mode === 'source');
    this.setReading(mode === 'read');
    this.showMode();
  }

  private showMode(): void {
    const mode = this.mode;
    for (const b of this.modeSwitch.querySelectorAll<HTMLElement>('button')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }

  /** What reading is, for the editor: nothing can be typed, clicked into or changed. */
  private readingExtension(): Extension {
    return this.reading ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
  }

  /**
   * Reading shows the note exactly as editing does (everything drawn, nothing as source), only
   * that nothing in it can be changed.
   */
  setReading(reading: boolean): void {
    if (reading === this.reading) return;
    this.reading = reading;
    this.showMode();
    // The note cannot be renamed from here either.
    this.titleInput.readOnly = reading;
    this.ctx.container.classList.toggle('pm-is-reading', reading);
    // What is drawn in the note is drawn anew: for writing, or for reading only.
    drawnFor.epoch++;
    this.editor.dispatch({
      effects: [
        this.readCompartment.reconfigure(this.readingExtension()),
        // Read as it is drawn, also while the notes are otherwise shown as source.
        this.modeCompartment.reconfigure(
          this.shared.sourceMode() && !reading ? sourceModeStyling : livePreview,
        ),
      ],
    });
    this.ctx.container.classList.toggle('pm-source-mode', this.shared.sourceMode() && !reading);
    if (reading) this.editor.contentDOM.blur();
    else this.editor.focus();
  }

  /** Scrolls to `Heading`, `H1#H2` or `^block` in this note. */
  revealSubpath(subpath: string): void {
    const path = this.handle?.path;
    const target =
      path !== undefined ? this.shared.index()?.resolveSubpath(path, subpath) : undefined;
    // The label of a figure, table or equation, as the note is right now.
    const id = /^#?\^(.+)$/.exec(subpath)?.[1];
    const item = id
      ? referableItems(this.editor.state.doc.toString()).find((i) => i.id === id)
      : undefined;
    if (item) {
      revealItem(this.editor, item);
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
      this.page.parentElement?.focus();
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
  /** Up from the first row of the note: into its name. False if the cursor is elsewhere. */
  enterTitle(): boolean {
    if (this.reading || this.titleInput.readOnly) return false;
    const view = this.editor;
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const fm = frontmatterBounds(view.state.doc.toString().slice(0, 4096));
    // The first line under the properties (which are not text of the note here).
    const doc = view.state.doc;
    let first = doc.lineAt(Math.min(fm ? fm.to : 0, doc.length));
    if (fm && first.from < fm.to && first.number < doc.lines) first = doc.line(first.number + 1);
    if (doc.lineAt(sel.head).number > first.number) return false;
    if (doc.lineAt(sel.head).number < first.number) return this.titleFocus();
    // The first row of that line, if it wraps.
    const here = view.coordsAtPos(sel.head);
    const top = view.coordsAtPos(first.from);
    if (here && top && Math.abs(here.top - top.top) > 4) return false;
    return this.titleFocus();
  }

  private titleFocus(): boolean {
    this.titleInput.focus();
    const end = this.titleInput.value.length;
    if (document.activeElement === this.titleInput) this.titleInput.setSelectionRange(end, end);
    return true;
  }

  private titleField: EditorView | undefined;
  private titleInEditor(): void {
    const extensions = this.shared.fieldExtensions();
    if (!extensions.length || this.titleField || this.titleInput.readOnly) return;
    const holder = document.createElement('div');
    holder.className = 'pm-inline-title has-editor';
    this.titleInput.after(holder);
    this.titleInput.hidden = true;
    this.titleField = lineField(
      holder,
      this.titleInput.value,
      extensions,
      'Note title',
      (text, onward) => {
        this.titleField = undefined;
        holder.remove();
        this.titleInput.hidden = false;
        this.titleInput.value = text;
        void this.renameFromTitle();
        if (onward) this.focusBody();
      },
    );
  }

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
    // A note that is being read stays drawn.
    const source = wanted && !this.reading;
    this.editor.dispatch({
      effects: this.modeCompartment.reconfigure(source ? sourceModeStyling : livePreview),
    });
    this.ctx.container.classList.toggle('pm-source-mode', source);
    this.showMode();
  }

  dispose(): void {
    this.disposed = true;
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
        // In front of the document's own: reading never changes it.
        this.readCompartment.of(this.readingExtension()),
        EditorState.readOnly.of(handle.readOnly),
        keymap.of([
          ...yUndoManagerKeymap,
          ...closeBracketsKeymap,
          ...searchKeymap,
          // Enter on an empty list item ends the list at once (the library's own first makes
          // the list a loose one, with an empty line between its items, when it is the second).
          { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
          { key: 'Backspace', run: deleteMarkupBackward },
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
          fieldExtensions: () => shared.fieldExtensions(),
          captionExtensions: (note) => shared.captionExtensions(note),
          links: () => shared.links(),
          run: (command, arg) => shared.run(command, arg),
          ...(shared.comment ? { comment: (v, range) => shared.comment!(v, range) } : {}),
        }),
        syntaxHighlighting(highlightStyle),
        EditorView.lineWrapping,
        drawSelection(),
        // Up from the first row of the note goes into its name (as down from there comes back).
        // (In front of the keys that move the cursor, which take the arrow at any place.)
        Prec.high(keymap.of([{ key: 'ArrowUp', run: () => this.enterTitle() }])),
        dropCursor(),
        rectangularSelection(),
        closeBrackets(),
        completionExtension({ closeLeft: () => this.shared.closeLeft() }),
        sectionFolding(),
        listEditing(),
        texHighlighting,
        findAndReplace(),
        highlightSelectionMatches(),
        placeholder('Start writing…'),
        EditorView.contentAttributes.of({
          spellcheck: 'true',
          autocorrect: 'on',
          autocapitalize: 'sentences',
        }),
        this.modeCompartment.of(
          this.shared.sourceMode() && !this.reading ? sourceModeStyling : livePreview,
        ),
        this.contributedCompartment.of(this.shared.contributed()),
        EditorView.updateListener.of((u) => {
          if (u.docChanged || u.focusChanged) this.shared.onActiveChange(this);
        }),
      ],
    });
  }

  private onMouseDown(e: MouseEvent): void {
    const link = (e.target as HTMLElement).closest<HTMLElement>('.cm-pm-link');
    const href = link?.dataset.href;
    // While reading a click follows a link; while writing it takes Cmd/Ctrl (a plain click
    // puts the cursor into its text).
    if (!href || !(this.reading || e.metaKey || e.ctrlKey)) return;
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
