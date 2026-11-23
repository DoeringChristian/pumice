import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  LanguageDescription,
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  basename,
  markdownText,
  type DocumentHandle,
  type DocumentsApi,
  type ViewContext,
  type ViewInstance,
  type ViewState,
  type WorkspaceApi,
} from '@pumice/api';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { highlightStyle } from './markdown-view';

/**
 * A file that holds text but is not a note (a .tex file, a script, a .json, …), shown and
 * edited as the text it is: nothing is rendered, the language is coloured when it is known.
 */
export class TextView implements ViewInstance {
  private editor: EditorView | undefined;
  private handle: DocumentHandle | undefined;
  private subs: Array<{ dispose(): void }> = [];
  private readonly language = new Compartment();
  private disposed = false;
  private path: string | undefined;

  constructor(
    private readonly ctx: ViewContext,
    private readonly deps: { documents: DocumentsApi; workspace: WorkspaceApi },
  ) {
    ctx.container.classList.add('pm-text-view');
  }

  async setState(state: ViewState): Promise<void> {
    const path = typeof state.path === 'string' ? state.path : undefined;
    if (!path || path === this.handle?.path) return;
    this.path = path;
    this.ctx.setFile(path);
    this.ctx.setTitle(basename(path));
    let handle: DocumentHandle;
    try {
      handle = await this.deps.documents.open(path);
    } catch (e) {
      if (this.disposed || this.path !== path) return;
      this.release();
      const message = document.createElement('div');
      message.className = 'pm-text-view-message';
      message.textContent = e instanceof Error ? e.message : String(e);
      this.ctx.container.replaceChildren(message);
      return;
    }
    if (this.disposed || this.path !== path) return handle.dispose();
    this.release();
    this.handle = handle;
    this.subs = [
      handle,
      handle.onDidRename((to) => {
        this.path = to;
        this.ctx.setFile(to);
        this.ctx.setTitle(basename(to));
      }),
      handle.onDidDelete(() => this.deps.workspace.closeFile(handle.path)),
    ];
    const text = markdownText(handle.doc);
    const undoManager = new Y.UndoManager(text);
    this.editor = new EditorView({
      parent: this.ctx.container,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          yCollab(text, (handle.awareness as Parameters<typeof yCollab>[1]) ?? null, {
            undoManager,
          }),
          EditorState.readOnly.of(handle.readOnly),
          keymap.of([
            ...yUndoManagerKeymap,
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          search({ top: true }),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          this.language.of([]),
          syntaxHighlighting(highlightStyle),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off' }),
        ],
      }),
    });
    // The language of the file, by its name: loaded when it is needed.
    const editor = this.editor;
    void LanguageDescription.matchFilename(languages, basename(path))
      ?.load()
      .then((support) => {
        if (this.editor === editor && !this.disposed)
          editor.dispatch({ effects: this.language.reconfigure(support) });
      })
      .catch(() => undefined);
  }

  getState(): ViewState {
    return this.path ? { path: this.path } : {};
  }

  focus(): void {
    this.editor?.focus();
  }

  private release(): void {
    for (const sub of this.subs) sub.dispose();
    this.subs = [];
    this.handle = undefined;
    this.editor?.destroy();
    this.editor = undefined;
    this.ctx.container.replaceChildren();
  }

  dispose(): void {
    this.disposed = true;
    this.release();
  }
}
