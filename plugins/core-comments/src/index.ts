import {
  Comments,
  Documents,
  Editor,
  Vault,
  MetadataIndex,
  PlatformService,
  SettingsUi,
  Workspace,
  Agents,
  agentMention,
  definePlugin,
  type LocatedThread,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import { h, settingItem, textInput } from '@pumice/ui';
import '@pumice/ui/panel.css';
import manifestJson from '../manifest.json';
import { commentBubble, openComposer } from './bubble';
import { commentEditorExtension, setActiveThread } from './editor-ext';
import { PanelState, renderPanel } from './panel';
import { COMMENTS_DIR, CommentStore } from './store';
import './comments.css';

export const manifest = manifestJson;
export { CommentStore } from './store';
export { createAnchor, resolveAnchor } from './anchor';

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const editor = ctx.use(Editor);
    const platform = ctx.use(PlatformService);
    const author = () => ctx.settings.get('author', '').trim() || 'Me';

    const store = new CommentStore({
      fs: platform.fs,
      index: ctx.use(MetadataIndex),
      documents: ctx.use(Documents),
      author,
    });
    ctx.register(() => store.dispose());
    ctx.provide(Comments, store);
    // Comments follow their note when it is renamed or moved.
    ctx.register(
      ctx.use(Vault).onDidChange((changes) => {
        for (const c of changes) {
          if (c.type === 'rename') void store.moved(c.oldPath, c.entry.path, c.entry.kind);
        }
      }),
    );
    // Comment files edited elsewhere (sync tools, another device): drop the cache.
    if (platform.watcher) {
      ctx.register(
        platform.watcher.watch((events) => {
          if (events.some((e) => e.path.startsWith(`${COMMENTS_DIR}/`))) store.invalidate();
        }),
      );
    }

    const state = new PanelState();
    const editorFor = (path: VaultPath) => {
      const active = editor.active();
      return active?.path === path ? active.view : undefined;
    };
    const isMac = /mac/i.test(navigator.platform);
    const showPanel = () => workspace.openView('comments', { location: 'right' });

    // Comments that mention an agent (`@agent`, `@claude`, …) are answered by it, in the thread.
    const agentAvailable = () => !!ctx.tryUse(Agents)?.available();
    /**
     * Whom a comment addresses: the `@name` in it, or, in a thread an agent answered before,
     * that agent's chat again (a reply there continues the conversation with it).
     */
    const addressed = (threadId: string | undefined, body: string): string | undefined => {
      const agents = ctx.tryUse(Agents);
      const names = agents?.available() ? agents.mentions().map((m) => m.mention) : [];
      const mention = agentMention(body, names);
      if (mention) return mention;
      return threadId && agents?.available() && agents.answers(threadId) ? 'agent' : undefined;
    };
    const mentions = () => {
      const agents = ctx.tryUse(Agents);
      return agents?.available() ? agents.mentions() : [];
    };
    const recipient = async (
      path: VaultPath,
      thread: { id?: string; range?: { from: number; to: number } | null },
      body: string,
    ): Promise<string | undefined> => {
      const mention = addressed(thread.id, body);
      if (!mention || !agentAvailable()) return undefined;
      return ctx.tryUse(Agents)!.recipient({
        path,
        mention,
        ...(thread.id ? { threadId: thread.id } : {}),
        ...(thread.range ? { range: thread.range } : {}),
      });
    };
    const maybeAskAgent = (path: VaultPath, threadId: string, body: string) => {
      const mention = addressed(threadId, body);
      if (!mention) return;
      if (!agentAvailable()) {
        workspace.notify('No assistant is available to answer this comment.', { kind: 'warning' });
        return;
      }
      void ctx
        .tryUse(Agents)!
        .replyToComment({ path, threadId, agent: mention })
        .catch((e: unknown) =>
          workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' }),
        );
    };
    const commentMode = () => ctx.settings.get('commentMode', false);

    ctx.register(
      editor.registerExtension((ectx) =>
        commentBubble(
          {
            commentMode,
            agentAvailable,
            recipient: (path, range, body) => recipient(path, { range }, body),
            mentions,
            submit: async (path, range, body) => {
              const thread = await store.addThread(path, range, body, author());
              state.focusThread = thread.id;
              state.fire();
              void showPanel();
              maybeAskAgent(path, thread.id, body);
            },
            saveDraft: async (path, range, body) => {
              const thread = await store.addThread(path, range, body, author(), { draft: true });
              state.focusThread = thread.id;
              state.fire();
              workspace.notify('Kept as a draft comment (not sent).', { timeout: 2500 });
            },
          },
          ectx,
        ),
      ),
    );

    ctx.register(
      editor.registerExtension((ectx) =>
        commentEditorExtension(
          {
            store,
            onClickThread: (_path, id) => {
              state.focusThread = id;
              state.fire();
              const view = editor.active()?.view;
              view?.dispatch({ effects: setActiveThread.of(id) });
              void showPanel();
            },
          },
          ectx,
        ),
      ),
    );

    ctx.register(
      workspace.registerView({
        type: 'comments',
        title: 'Comments',
        icon: 'message-square',
        create(view) {
          return renderPanel(
            view.container,
            {
              store,
              workspace,
              editorFor,
              author,
              hasAgent: agentAvailable,
              deleted: (what) =>
                workspace.notify(
                  `${what === 'thread' ? 'Thread' : 'Comment'} deleted. ${isMac ? '⌘Z' : 'Ctrl+Z'} brings it back.`,
                  { timeout: 4000 },
                ),
              onReply: maybeAskAgent,
              recipient,
              mentions,
              commentMode,
              setCommentMode: (on: boolean) => void ctx.settings.set('commentMode', on),
              askAgent: (path: VaultPath, thread: LocatedThread) =>
                void ctx
                  .tryUse(Agents)
                  ?.replyToComment({ path, threadId: thread.id, agent: 'agent' })
                  .catch((e: unknown) =>
                    workspace.notify(e instanceof Error ? e.message : String(e), { kind: 'error' }),
                  ),
            },
            state,
          );
        },
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'comments',
        side: 'right',
        viewType: 'comments',
        title: 'Comments',
        icon: 'message-square',
        order: 20,
      }),
    );

    /** On the selection, or on a range that is given (a picture's "comment" button). */
    const addComment = (given?: unknown) => {
      const active = editor.active();
      if (!active) return;
      const g = given as { from?: unknown; to?: unknown } | undefined;
      const { from, to } =
        typeof g?.from === 'number' && typeof g.to === 'number'
          ? { from: g.from, to: g.to }
          : active.view.state.selection.main;
      let range = { from, to };
      if (from === to) {
        // No selection: comment on the word at the cursor.
        const word = active.view.state.wordAt(from);
        if (word) range = { from: word.from, to: word.to };
      }
      // The comment box opens next to the text.
      active.view.dispatch({ effects: openComposer.of(range) });
    };

    ctx.commands.register({
      id: 'comments.add',
      title: 'Add comment',
      category: 'Comments',
      hotkeys: ['Mod+Alt+M'],
      when: () => !!editor.active(),
      run: addComment,
    });
    ctx.commands.register({
      id: 'comments.toggle-mode',
      title: 'Comment mode: comment as soon as text is selected (on/off)',
      category: 'Comments',
      run: async () => {
        await ctx.settings.set('commentMode', !commentMode());
        state.fire();
        workspace.notify(
          commentMode() ? 'Comment mode on: select text to comment' : 'Comment mode off',
          {
            timeout: 2000,
          },
        );
      },
    });
    // Cmd/Ctrl+Z brings a deleted comment back, unless something that has its own undo (the
    // note, a text field, a drawing) has the focus.
    const undoApplies = () => {
      if (!store.canUndoDelete) return false;
      const active = document.activeElement;
      if (!active || active === document.body) return true;
      if (active.closest('input, textarea, [contenteditable="true"], .cm-editor')) return false;
      return !!active.closest('.pm-comments, .pm-panel');
    };
    ctx.commands.register({
      id: 'comments.undo-delete',
      title: 'Bring back the deleted comment',
      category: 'Comments',
      hotkeys: ['Mod+Z'],
      when: undoApplies,
      run: async () => {
        const path = await store.undoDelete();
        if (path !== undefined) workspace.notify('Comment restored.', { timeout: 2000 });
      },
    });
    ctx.commands.register({
      id: 'comments.show',
      title: 'Show comments',
      category: 'Comments',
      run: showPanel,
    });
    ctx.register(
      editor.registerContextMenuItem({
        id: 'comments.add',
        label: 'Add comment',
        icon: 'message-square-plus',
        order: 10,
        run: () => addComment(),
      }),
    );
    ctx.register(
      editor.registerToolbarAction({
        id: 'comments.add',
        title: 'Add comment',
        icon: 'message-square-plus',
        order: 80,
        run: () => addComment(),
      }),
    );

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'comments',
          title: 'Comments',
          group: 'plugins',
          render(container) {
            container.replaceChildren(
              h('h2', {}, 'Comments'),
              settingItem(
                'Your name',
                'Shown on comments you write.',
                textInput(
                  ctx.settings.get('author', ''),
                  (v) => void ctx.settings.set('author', v.trim()),
                ),
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
