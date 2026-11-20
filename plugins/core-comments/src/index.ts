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
    const showPanel = () => workspace.openView('comments', { location: 'right' });

    // Comments that mention an agent (`@agent`, `@claude`, …) are answered by it, in the thread.
    const agentAvailable = () => !!ctx.tryUse(Agents)?.available();
    const maybeAskAgent = (path: VaultPath, threadId: string, body: string) => {
      const mention = agentMention(body);
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
            submit: async (path, range, body) => {
              const thread = await store.addThread(path, range, body, author());
              state.focusThread = thread.id;
              state.fire();
              void showPanel();
              maybeAskAgent(path, thread.id, body);
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
              onReply: maybeAskAgent,
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

    const addComment = () => {
      const active = editor.active();
      if (!active) return;
      const { from, to } = active.view.state.selection.main;
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
        run: addComment,
      }),
    );
    ctx.register(
      editor.registerToolbarAction({
        id: 'comments.add',
        title: 'Add comment',
        icon: 'message-square-plus',
        order: 80,
        run: addComment,
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
