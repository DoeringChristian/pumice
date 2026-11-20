import type { EditorView } from '@codemirror/view';
import { Emitter, type LocatedThread, type VaultPath, type WorkspaceApi } from '@pumice/api';
import { button, createIcon, debounce, h } from '@pumice/ui';
import { setActiveThread } from './editor-ext';
import type { CommentStore } from './store';

/** A comment being written for a new thread. */
export interface Draft {
  path: VaultPath;
  from: number;
  to: number;
  quote: string;
}

export interface PanelDeps {
  store: CommentStore;
  workspace: WorkspaceApi;
  /** The active editor showing `path`, if any. */
  editorFor(path: VaultPath): EditorView | undefined;
  author(): string;
  /** Whether an agent plugin is available to hand threads to. */
  hasAgent(): boolean;
  askAgent(path: VaultPath, thread: LocatedThread): void;
}

/** Shared state between the commands and the panel. */
export class PanelState {
  draft: Draft | undefined;
  focusThread: string | undefined;
  showResolved = false;
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  fire() {
    this.changed.fire();
  }
}

const relativeTime = (iso: string) => {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function composer(
  placeholder: string,
  submitLabel: string,
  onSubmit: (body: string) => Promise<unknown>,
  onCancel?: () => void,
): HTMLElement {
  const input = h('textarea', {
    class: 'pm-comment-input',
    placeholder,
    rows: 2,
    'aria-label': placeholder,
  });
  const submit = async () => {
    const body = input.value.trim();
    if (!body) return;
    input.disabled = true;
    try {
      await onSubmit(body);
      input.value = '';
    } finally {
      input.disabled = false;
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  });
  const actions = h(
    'div',
    { class: 'pm-comment-actions' },
    onCancel ? button('Cancel', onCancel, { kind: 'plain' }) : null,
    button(submitLabel, () => void submit(), { kind: 'primary' }),
  );
  return h('div', { class: 'pm-comment-composer' }, input, actions);
}

export function renderPanel(container: HTMLElement, deps: PanelDeps, state: PanelState) {
  const { store, workspace } = deps;
  const body = h('div', { class: 'pm-panel-scroll pm-comments' });
  const resolvedToggle = h('input', { type: 'checkbox', checked: state.showResolved });
  resolvedToggle.addEventListener('change', () => {
    state.showResolved = resolvedToggle.checked;
    void render();
  });
  container.append(
    h(
      'div',
      { class: 'pm-panel' },
      h(
        'div',
        { class: 'pm-panel-toolbar pm-comments-toolbar' },
        h('label', { class: 'pm-comments-filter' }, resolvedToggle, ' Show resolved'),
      ),
      body,
    ),
  );

  const reveal = (path: VaultPath, t: LocatedThread) => {
    state.focusThread = t.id;
    const view = deps.editorFor(path);
    if (view && t.range) {
      view.dispatch({
        selection: { anchor: t.range.from, head: t.range.to },
        effects: [setActiveThread.of(t.id), EditorView_scrollIntoView(view, t.range.from)],
      });
      view.focus();
    } else if (t.range) {
      void workspace.openFile(path, { state: { offset: t.range.from } });
    }
    void render();
  };

  const run = (p: Promise<unknown>) =>
    p.catch((e: unknown) =>
      workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' }),
    );

  const threadCard = (path: VaultPath, t: LocatedThread): HTMLElement => {
    const focused = state.focusThread === t.id;
    const card = h('article', {
      class: `pm-comment-thread${focused ? ' is-focused' : ''}${t.resolved ? ' is-resolved' : ''}${t.range ? '' : ' is-detached'}`,
      dataset: { thread: t.id },
    });
    const quote = h(
      'button',
      {
        class: 'pm-comment-quote',
        title: t.range ? 'Show in note' : 'The commented text was removed',
        onclick: () => reveal(path, t),
      },
      t.anchor.exact.trim()
        ? t.anchor.exact.replace(/\s+/g, ' ').slice(0, 160)
        : '(empty selection)',
    );
    const header = h(
      'div',
      { class: 'pm-comment-thread-actions' },
      deps.hasAgent()
        ? h(
            'button',
            {
              class: 'pm-icon-button',
              title: 'Ask an agent to address this',
              onclick: () => deps.askAgent(path, t),
            },
            createIcon('bot', 14),
          )
        : null,
      h(
        'button',
        {
          class: 'pm-icon-button',
          title: t.resolved ? 'Reopen' : 'Resolve',
          onclick: () => {
            if (!t.resolved) {
              state.focusThread = undefined;
              deps.editorFor(path)?.dispatch({ effects: setActiveThread.of(null) });
            }
            void run(store.setResolved(path, t.id, !t.resolved));
          },
        },
        createIcon(t.resolved ? 'refresh-cw' : 'check', 14),
      ),
      h(
        'button',
        {
          class: 'pm-icon-button',
          title: 'Delete thread',
          onclick: async () => {
            if (await workspace.confirm('Delete this comment thread?'))
              void run(store.deleteThread(path, t.id));
          },
        },
        createIcon('trash', 14),
      ),
    );
    card.append(h('div', { class: 'pm-comment-thread-head' }, quote, header));
    for (const c of t.comments) {
      const text = h('div', { class: 'pm-comment-body' }, c.body);
      const entry = h(
        'div',
        { class: 'pm-comment' },
        h(
          'div',
          { class: 'pm-comment-meta' },
          h('span', { class: 'pm-comment-author' }, c.author),
          h(
            'span',
            { class: 'pm-comment-time', title: new Date(c.created).toLocaleString() },
            relativeTime(c.created) + (c.edited ? ' (edited)' : ''),
          ),
          h(
            'button',
            {
              class: 'pm-icon-button pm-comment-more',
              title: 'More',
              onclick: (e: MouseEvent) =>
                workspace.showContextMenu(
                  [
                    {
                      label: 'Edit',
                      icon: 'pencil',
                      run: () => {
                        const editor = composer(
                          'Edit comment',
                          'Save',
                          (b) => run(store.editComment(path, t.id, c.id, b)),
                          () => editor.replaceWith(text),
                        );
                        (editor.querySelector('textarea') as HTMLTextAreaElement).value = c.body;
                        text.replaceWith(editor);
                        editor.querySelector('textarea')?.focus();
                      },
                    },
                    {
                      label: 'Copy text',
                      icon: 'copy',
                      run: () => navigator.clipboard.writeText(c.body),
                    },
                    {
                      label: 'Delete',
                      icon: 'trash',
                      danger: true,
                      run: () => run(store.deleteComment(path, t.id, c.id)),
                    },
                  ],
                  { x: e.clientX, y: e.clientY },
                ),
            },
            createIcon('chevron-down', 12),
          ),
        ),
        text,
      );
      card.append(entry);
    }
    if (focused && !t.resolved) {
      card.append(composer('Reply…', 'Reply', (b) => run(store.reply(path, t.id, b))));
    } else if (!t.resolved) {
      card.append(
        h(
          'button',
          {
            class: 'pm-comment-reply-link',
            onclick: () => {
              state.focusThread = t.id;
              void render().then(() =>
                body
                  .querySelector<HTMLTextAreaElement>(`[data-thread="${t.id}"] textarea`)
                  ?.focus(),
              );
            },
          },
          'Reply',
        ),
      );
    }
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, textarea')) return;
      reveal(path, t);
    });
    return card;
  };

  /** Focuses the new-comment box, once the panel is on screen (it may still be opening). */
  const focusDraft = (tries = 10) => {
    const input = body.querySelector<HTMLTextAreaElement>('.is-draft textarea');
    if (!input) return;
    if (input.isConnected && input.offsetParent !== null) {
      input.focus();
      if (document.activeElement === input) return;
    }
    if (tries > 0) requestAnimationFrame(() => focusDraft(tries - 1));
  };

  let generation = 0;
  const render = async () => {
    const gen = ++generation;
    const path = workspace.activeFile;
    if (!path || !path.toLowerCase().endsWith('.md')) {
      body.replaceChildren(h('div', { class: 'pm-panel-empty' }, 'No note open.'));
      return;
    }
    const threads = await store.threads(path);
    if (gen !== generation) return;
    const children: HTMLElement[] = [];
    const draft = state.draft?.path === path ? state.draft : undefined;
    if (draft) {
      children.push(
        h(
          'article',
          { class: 'pm-comment-thread is-focused is-draft' },
          h('div', { class: 'pm-comment-quote' }, draft.quote.replace(/\s+/g, ' ').slice(0, 160)),
          composer(
            'Add a comment… (⌘/Ctrl+Enter to send)',
            'Comment',
            async (b) => {
              const t = await store.addThread(
                path,
                { from: draft.from, to: draft.to },
                b,
                deps.author(),
              );
              state.draft = undefined;
              state.focusThread = t.id;
            },
            () => {
              state.draft = undefined;
              void render();
            },
          ),
        ),
      );
    }
    const visible = threads.filter((t) => state.showResolved || !t.resolved);
    for (const t of visible.filter((x) => x.range)) children.push(threadCard(path, t));
    const detached = visible.filter((x) => !x.range);
    if (detached.length) {
      children.push(h('div', { class: 'pm-panel-section-title' }, 'Text no longer in the note'));
      for (const t of detached) children.push(threadCard(path, t));
    }
    if (!children.length) {
      const resolved = threads.length - visible.length;
      children.push(
        h(
          'div',
          { class: 'pm-panel-empty' },
          resolved
            ? `No open comments (${resolved} resolved).`
            : 'No comments. Select text and press ⌘/Ctrl+Alt+M, or right-click → Add comment.',
        ),
      );
    }
    body.replaceChildren(...children);
    if (draft) focusDraft();
    else if (state.focusThread)
      body
        .querySelector(`[data-thread="${state.focusThread}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  };

  const later = debounce(() => void render(), 100);
  const subs = [
    workspace.onDidChangeActiveFile(() => {
      state.focusThread = undefined;
      later();
    }),
    store.onDidChange((p) => p === workspace.activeFile && later()),
    state.onDidChange(later),
  ];
  void render();
  return {
    focus() {
      focusDraft();
    },
    dispose() {
      later.cancel();
      for (const s of subs) s.dispose();
    },
  };
}

/** `EditorView.scrollIntoView` without importing the class (keeps this module DOM-only). */
function EditorView_scrollIntoView(view: EditorView, pos: number) {
  return (view.constructor as typeof import('@codemirror/view').EditorView).scrollIntoView(pos, {
    y: 'center',
  });
}
