import {
  AuthoredChange,
  Documents,
  Drawings,
  Agents,
  Comments,
  Editor,
  MetadataIndex,
  MarkdownSyntax,
  PlatformService,
  ShellService,
  SettingsUi,
  Vault,
  Workspace,
  definePlugin,
  markdownText,
  type AuthorPresence,
  type ChangeAuthor,
  type ChatGptHost,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import { button, h, settingItem, textInput, toggle } from '@pumice/ui';
import '@pumice/ui/panel.css';
import { applyTextDiff, applyTextDiffAs } from '@pumice/core-documents';
import manifestJson from '../manifest.json';
import { ChatStore, newChatId, storableItems, type SavedChat } from './chats';
import { Ledger, revertChange, trackedFiles, type AgentChange } from './ledger';
import { ChatManager, chatName, mentionOf, type OpenChat } from './manager';
import { AgentPanelState, renderAgentPanel, type Attachment } from './panel';
import { offsetOf, type WrittenPlace } from './references';
import { ChatGptSession } from './chatgpt-session';
import {
  vaultPathOf,
  AgentSession,
  DEFAULT_AGENTS,
  type AgentConfig,
  type AgentFiles,
  type ChatSession,
} from './session';
import './agents.css';

export const manifest = manifestJson;
export { AgentSession, DEFAULT_AGENTS } from './session';

/** The colour an assistant's changes and name are shown in. */
const AGENT_COLOR = '#8b5cf6';

/** Splits a command line into words (double quotes group). */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g))
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!);
  return out;
}

const joinCommand = (c: AgentConfig) =>
  [c.command, ...c.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

/** Settings row: who is signed in with ChatGPT, with sign in / sign out. */
function chatgptRow(chatgpt: ChatGptHost): HTMLElement {
  const status = h('span', {}, 'Checking…');
  const action = button('Sign in', () => undefined);
  const refresh = async () => {
    const s = await chatgpt.status().catch(() => undefined);
    status.textContent = !s?.signedIn
      ? 'Not signed in.'
      : `Signed in${s.email ? ` as ${s.email}` : ''}${s.planUsage ? '' : ' (plan usage not allowed: sign in again)'}.`;
    action.textContent = s?.signedIn ? 'Sign out' : 'Sign in';
    action.onclick = async () => {
      if (s?.signedIn) await chatgpt.logout();
      else {
        await chatgpt.login();
        // The browser takes over; look again when the user comes back.
        window.addEventListener('focus', () => void refresh(), { once: true });
      }
      await refresh();
    };
  };
  void refresh();
  return settingItem(
    'ChatGPT (your plan)',
    h(
      'span',
      {},
      'The built-in assistant runs on your ChatGPT subscription through OpenAI’s “Sign in with ChatGPT”. Nothing to install; the sign-in stays on this computer.',
      h('br'),
      status,
    ),
    action,
  );
}

export const plugin = definePlugin({
  activate(ctx) {
    const workspace = ctx.use(Workspace);
    const editor = ctx.use(Editor);
    const documents = ctx.use(Documents);
    const vault = ctx.use(Vault);
    const syntax = ctx.use(MarkdownSyntax);
    const platform = ctx.use(PlatformService);
    // Drawings read and changed as text (absent without the drawing plugin). Asked for when a
    // chat starts, not now: the drawing plugin starts after this one (naming it as a dependency
    // would close a circle through the reader and the frames, which wait for this plugin).
    const drawingsNow = () => ctx.tryUse(Drawings);
    const host = platform.process;
    const root = platform.vaultRoot ?? '';

    // What an answer refers to: a file by its path, also as the system has it, or by its name.
    const placeOf = (place: WrittenPlace): VaultPath | undefined => {
      let path = place.path;
      if (root && path.startsWith('/')) path = vaultPathOf(root, path);
      if (!path || path.startsWith('/')) return undefined;
      if (vault.get(path)?.kind === 'file') return path as VaultPath;
      return ctx.tryUse(MetadataIndex)?.resolve(path, '' as VaultPath)?.file.path;
    };
    const openPlace = async (path: string, place: WrittenPlace, newTab: boolean) => {
      const state: Record<string, unknown> = {};
      if (place.subpath) state.subpath = place.subpath;
      if (place.line && /\.md$/i.test(path))
        state.offset = offsetOf(await documents.read(path as VaultPath), place.line, place.column);
      await workspace.openFile(path as VaultPath, { newTab, state });
    };

    const agents = (): AgentConfig[] => {
      const overrides = ctx.settings.get<Record<string, string>>('commands', {});
      // The ChatGPT assistant needs the shell's sign-in; the others are programs to run.
      const usable = DEFAULT_AGENTS.filter((a) =>
        a.kind === 'chatgpt' ? !!platform.chatgpt : !!host,
      );
      return usable.map((a) => {
        const line = a.kind === 'chatgpt' ? undefined : overrides[a.id]?.trim();
        if (!line) return a;
        const [command, ...args] = splitCommand(line);
        return { ...a, command: command!, args };
      });
    };
    const currentAgent = () => {
      const id = ctx.settings.get('agent', 'chatgpt');
      return agents().some((a) => a.id === id) ? id : agents()[0]!.id;
    };

    /** Who an assistant is, where its changes are shown (in the colour of assistants). */
    const authorOf = (config: AgentConfig): ChangeAuthor => ({
      kind: 'agent',
      name: config.name.replace(/\s*\(.*\)$/, ''),
      color: AGENT_COLOR,
    });
    /**
     * The Yjs client each assistant edits as, one per assistant in this window: its changes are
     * its own in the document (collaborators see them as its, not as the person's who runs it).
     */
    const agentClients = new Map<string, number>();
    const clientOf = (name: string) => {
      let id = agentClients.get(name);
      if (id === undefined) {
        id = crypto.getRandomValues(new Uint32Array(1))[0]!;
        agentClients.set(name, id);
      }
      return id;
    };
    /**
     * Writes a note through its document, so the change merges live with the editor and with
     * collaborators: in small steps (only what changed), under `author` (an assistant's own name
     * and colour; none for what the user asked for, like taking a change back).
     */
    const writeNote = async (path: VaultPath, content: string, author?: ChangeAuthor) => {
      if (!vault.get(path) || !/\.(md|markdown|txt)$/i.test(path)) {
        await vault.write(path, content);
        return;
      }
      const handle = await documents.open(path);
      try {
        const doc = handle.doc;
        const ytext = markdownText(doc);
        if (ytext.toString() === content) return;
        if (!author) {
          doc.transact(() => applyTextDiff(ytext, content), 'agent-undo');
          return;
        }
        const client = clientOf(author.name);
        // In a shared vault the others learn whose that client is.
        const presence = handle.awareness as
          | {
              getLocalState(): AuthorPresence | null;
              setLocalStateField(field: string, value: unknown): void;
            }
          | undefined;
        const listed = presence?.getLocalState()?.agents ?? [];
        if (presence && !listed.some((a) => a.client === client))
          presence.setLocalStateField('agents', [
            ...listed,
            { client, name: author.name, color: author.color },
          ]);
        // Made as the assistant's own Yjs client: its text is its own in the document.
        applyTextDiffAs(doc, 'content', content, client, new AuthoredChange(author));
      } finally {
        handle.dispose();
      }
    };
    /** Agent file access: open notes are edited in their documents, so changes merge live. */
    const filesAs = (author: ChangeAuthor): AgentFiles => ({
      root,
      read: async (path) => documents.peek(path) ?? (await vault.read(path)),
      write: (path, content) => writeNote(path, content, author),
    });
    const files = filesAs({ kind: 'agent', name: 'Assistant', color: AGENT_COLOR });

    // How features of the app are used, contributed by other plugins (frames, …).
    const guidanceSources = new Set<() => string>();
    const guidance = () =>
      [...guidanceSources]
        .map((text) => text())
        .filter(Boolean)
        .join('\n\n');

    // Conversations are saved as they go, and can be picked up again from the panel.
    const chats = new ChatStore(platform.fs);
    // Which chat changed what, and which chat answers which comment thread.
    const ledger = new Ledger(platform.fs);
    void ledger.load();
    ctx.register(() => void ledger.flush());

    const createSession = (agentId: string, saved?: SavedChat): ChatSession => {
      const config = agents().find((a) => a.id === agentId) ?? agents()[0]!;
      // Each chat has its own view of the files: it does not overwrite what it has not seen.
      const ref = { id: saved?.id ?? '' };
      // Its changes are shown under its own name.
      const own = trackedFiles(filesAs(authorOf(config)), ledger, () => {
        const chat = manager.get(ref.id);
        return { id: ref.id, name: chat ? chatName(chat) : config.name };
      });
      const s: ChatSession =
        config.kind === 'chatgpt'
          ? new ChatGptSession(
              config,
              {
                host: platform.chatgpt!,
                files: own,
                index: ctx.use(MetadataIndex),
                vault,
                savedModel: () => ctx.settings.get<string | undefined>('chatgptModel', undefined),
                saveModel: (id) => void ctx.settings.set('chatgptModel', id),
                savedMode: () => ctx.settings.get<string | undefined>('chatgptMode', undefined),
                saveMode: (id) => void ctx.settings.set('chatgptMode', id),
                guidance,
                drawings: drawingsNow,
                ...(platform.net ? { net: platform.net } : {}),
                webAccess: () => ctx.settings.get('webAccess', true),
                webAlwaysAllowed: () => !ctx.settings.get('webAsk', true),
                allowWebAlways: () => void ctx.settings.set('webAsk', false),
                saveFile: async (path, bytes) => {
                  if (vault.get(path)) throw new Error(`${path} already exists.`);
                  await vault.create(path, bytes);
                },
              },
              saved,
            )
          : new AgentSession(config, host!, own, guidance, saved);
      ref.id = s.chatId;
      return s;
    };
    // Several chats run at once; the panel shows one of them.
    const manager = new ChatManager(createSession);
    ctx.register(() => manager.dispose());

    const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const saveNow = (chat: OpenChat) => {
      const s = chat.session;
      clearTimeout(saveTimers.get(s.chatId));
      saveTimers.delete(s.chatId);
      void chats
        .save(s.chatId, s.config.id, s.snapshot(), chat.name)
        .catch((e: unknown) => console.error('[pumice] could not save the chat', e));
    };
    const openChat = (agentId: string, saved?: SavedChat): OpenChat => {
      const known = manager.get(saved?.id);
      if (known) return known;
      const chat = manager.start(agentId, saved);
      const s = chat.session;
      s.onDidChange(() => {
        if (!s.items.some((i) => i.kind === 'user')) return;
        clearTimeout(saveTimers.get(s.chatId));
        saveTimers.set(
          s.chatId,
          setTimeout(() => saveNow(chat), 1000),
        );
      });
      return chat;
    };
    const resumeChat = async (id: string): Promise<OpenChat | undefined> => {
      const open = manager.get(id);
      if (open) return open;
      const saved = await chats.load(id);
      // Deleted meanwhile: nothing to say.
      if (!saved) return undefined;
      if (!agents().some((a) => a.id === saved.agent)) {
        workspace.notify('This chat can’t be opened here.', { kind: 'warning' });
        return undefined;
      }
      return openChat(saved.agent, saved);
    };
    /** A second chat that starts with everything said in this one; both go on separately. */
    const forkChat = (id: string, name?: string): OpenChat | undefined => {
      const chat = manager.get(id);
      if (!chat) return undefined;
      const snapshot = chat.session.snapshot();
      const now = new Date().toISOString();
      const title = name?.trim() || `${chatName(chat)} (fork)`;
      const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
      const saved: SavedChat = {
        version: 1,
        id: newChatId(),
        agent: chat.session.config.id,
        title,
        name: title,
        created: now,
        updated: now,
        forkedFrom: id,
        items: copy(storableItems(snapshot.items)),
        // The built-in assistant continues from the same conversation state; an external
        // agent is told what was said (its own session cannot be shared by two chats).
        ...(snapshot.input ? { input: copy(snapshot.input) } : {}),
      };
      const fork = openChat(saved.agent, saved);
      saveNow(fork);
      return fork;
    };
    const closeChat = (id: string) => {
      const chat = manager.get(id);
      // Write what is pending before the conversation goes.
      if (chat && saveTimers.has(id)) saveNow(chat);
      manager.close(id);
    };

    /** Takes back one change an agent made to a note, if the text is still as it left it. */
    const undoChange = async (change: AgentChange) => {
      const text = await files.read(change.path);
      const next = revertChange(change, text);
      if (next === undefined) {
        workspace.notify('The text has changed since; this change can’t be taken back.', {
          kind: 'warning',
        });
        return;
      }
      await writeNote(change.path, next);
      ledger.forget(change);
    };

    const state = new AgentPanelState();
    const fileUri = (path: VaultPath) =>
      `file://${root.replace(/\\/g, '/')}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const currentNote = (): Attachment | undefined => {
      const path = workspace.activeFile;
      if (!path) return undefined;
      return { label: path, blocks: [{ type: 'resource_link', uri: fileUri(path), name: path }] };
    };

    ctx.register(
      workspace.registerView({
        type: 'agent',
        title: 'Agent',
        icon: 'bot',
        create(view) {
          return renderAgentPanel(
            view.container,
            {
              workspace,
              syntax,
              places: {
                resolve: placeOf,
                open: (path, place, newTab) => void openPlace(path, place, newTab),
                openExternal: (url) => void ctx.tryUse(ShellService)?.openExternal(url),
              },
              agents,
              available: (!!host || !!platform.chatgpt) && !!root,
              root,
              manager,
              newChat: (agentId) => openChat(agentId),
              listChats: () => chats.list(),
              resumeChat,
              closeChat,
              forkChat,
              renameChat: (id, name) => {
                manager.rename(id, name);
                const chat = manager.get(id);
                if (chat) saveNow(chat);
              },
              deleteChat: async (id) => {
                manager.close(id);
                clearTimeout(saveTimers.get(id));
                saveTimers.delete(id);
                await chats.remove(id);
              },
              lastChat: () => ctx.settings.get<string | undefined>('activeChat', undefined),
              setLastChat: (id) => void ctx.settings.set('activeChat', id),
              changesFor: (path) => ledger.changesFor(path),
              undoChange,
              currentAgent,
              setCurrentAgent: (id) => void ctx.settings.set('agent', id),
              currentNote,
            },
            state,
          );
        },
      }),
    );
    ctx.register(
      workspace.registerSidebarPanel({
        id: 'agent',
        side: 'right',
        viewType: 'agent',
        title: 'Agent',
        icon: 'bot',
        order: 30,
      }),
    );
    const showPanel = () => workspace.openView('agent', { location: 'right' });
    ctx.register(
      workspace.registerRibbonAction({
        id: 'agents.open',
        icon: 'bot',
        title: 'Agent chat',
        order: 80,
        run: showPanel,
      }),
    );

    /** `agents.ask` — attach a note range (and optionally a prompt) and open the chat. */
    const ask = async (arg?: unknown) => {
      const a = (arg ?? {}) as {
        path?: VaultPath;
        range?: { from: number; to: number };
        prompt?: string;
      };
      let path = a.path;
      let range = a.range;
      let text: string | undefined;
      if (!path) {
        const active = editor.active();
        if (active) {
          path = active.path;
          const sel = active.view.state.selection.main;
          if (!sel.empty) range = { from: sel.from, to: sel.to };
        }
      }
      if (path && range) {
        const doc = documents.peek(path) ?? (await vault.read(path));
        text = doc.slice(range.from, range.to);
        const line = (pos: number) => doc.slice(0, pos).split('\n').length;
        const l1 = line(range.from);
        const l2 = line(Math.max(range.from, range.to - 1));
        const label = `${path}:${l1 === l2 ? l1 : `${l1}-${l2}`}`;
        state.attachments.push({
          label,
          blocks: [
            {
              type: 'resource',
              resource: {
                uri: `${fileUri(path)}#L${l1}${l2 !== l1 ? `-${l2}` : ''}`,
                mimeType: 'text/markdown',
                text,
              },
            },
          ],
        });
      }
      if (a.prompt) state.draft = a.prompt;
      await showPanel();
      state.fire();
    };
    // ---- Comments addressed to an agent (`@agent …`): it answers in the thread ----------------

    /** Resolves once the session can take a prompt; false if it can't (sign-in, crash). */
    const whenReady = (s: ChatSession) =>
      new Promise<boolean>((resolve) => {
        const check = () => {
          if (s.status === 'ready' || s.status === 'working') return done(true);
          if (s.status === 'error' || s.status === 'closed') return done(false);
        };
        const sub = s.onDidChange(check);
        const done = (ok: boolean) => {
          sub.dispose();
          resolve(ok);
        };
        check();
      });

    /** Who answers a comment: an open chat, a saved one to open again, or a new chat. */
    type Recipient =
      | { kind: 'open'; chat: OpenChat }
      | { kind: 'saved'; id: string; title: string }
      | { kind: 'new'; agent: AgentConfig };

    const known = async (chatId: string | undefined): Promise<Recipient | undefined> => {
      if (!chatId) return undefined;
      const open = manager.get(chatId);
      if (open) return { kind: 'open', chat: open };
      const saved = (await chats.list()).find((c) => c.id === chatId);
      return saved && agents().some((a) => a.id === saved.agent)
        ? { kind: 'saved', id: saved.id, title: saved.title }
        : undefined;
    };

    /**
     * `@name` is the chat (or agent) of that name. `@agent` is, in this order: the chat that
     * answered the thread before, the chat that wrote the commented text, the chat the panel
     * shows, the chat opened last, a new chat.
     */
    const resolve = async (
      path: VaultPath,
      threadId: string | undefined,
      range: { from: number; to: number } | null | undefined,
      mention = 'agent',
    ): Promise<Recipient | undefined> => {
      const list = agents();
      if (!list.length) return undefined;
      const wanted = mention.toLowerCase();
      if (wanted !== 'agent' && wanted !== 'assistant') {
        const named = manager.byMention(wanted);
        if (named) return { kind: 'open', chat: named };
        const agent = list.find((c) => c.id === wanted);
        if (agent) return { kind: 'new', agent };
      }
      await ledger.load();
      const answered = await known(threadId ? ledger.threadChat(threadId) : undefined);
      if (answered) return answered;
      if (range) {
        const text = await files.read(path).catch(() => '');
        const author = await known(ledger.chatForRange(path, text, range));
        if (author) return author;
      }
      const shown = manager.active ?? manager.open[manager.open.length - 1];
      if (shown) return { kind: 'open', chat: shown };
      return { kind: 'new', agent: list.find((c) => c.id === currentAgent()) ?? list[0]! };
    };

    const describe = (r: Recipient | undefined): string | undefined =>
      !r
        ? undefined
        : r.kind === 'open'
          ? chatName(r.chat)
          : r.kind === 'saved'
            ? r.title
            : `a new chat with ${r.agent.name.replace(/\s*\(.*\)$/, '')}`;

    const mentions = () => [
      { mention: 'agent', label: 'The chat that fits best', detail: 'wrote the text, or is open' },
      ...manager.open.flatMap((chat) => {
        const mention = mentionOf(chatName(chat));
        return mention
          ? [{ mention, label: chatName(chat), detail: chat.session.config.name }]
          : [];
      }),
      ...agents().map((a) => ({ mention: a.id, label: a.name, detail: 'agent' })),
    ];

    const replyToComment = async (a: { path: VaultPath; threadId: string; agent?: string }) => {
      const comments = ctx.tryUse(Comments);
      if (!comments || !a.path || !a.threadId) return;
      const path = a.path;
      const threadId = a.threadId;
      const located = (await comments.threads(path)).find((t) => t.id === threadId);
      const to = await resolve(path, threadId, located?.range, a.agent);
      if (!to) throw new Error('No assistant is available here (desktop app only).');

      let chat: OpenChat | undefined =
        to.kind === 'open'
          ? to.chat
          : to.kind === 'saved'
            ? await resumeChat(to.id)
            : openChat(to.agent.id);
      // A chat whose agent stopped starts again from what was saved.
      if (chat?.session.status === 'closed') {
        const { chatId, config } = chat.session;
        closeChat(chatId);
        chat = (await resumeChat(chatId)) ?? openChat(config.id);
      }
      if (!chat) throw new Error('The chat for this comment can’t be opened.');
      const session = chat.session;
      const config = session.config;
      const who = chat.name ?? config.name;

      const placeholder = await comments.reply(
        path,
        threadId,
        session.status === 'working' || chat.queue.length
          ? 'Busy with something else; this is next…'
          : 'Working on it…',
        who,
      );
      const finish = (text: string) => comments.editComment(path, threadId, placeholder.id, text);

      try {
        if (!(await whenReady(session))) {
          const needsSignIn = session.loginOptions.length > 0;
          await finish(
            needsSignIn
              ? `${config.name} needs you to sign in first. Open the assistant panel, sign in, then mention it again.`
              : `${config.name} could not start. Open the assistant panel to see why.`,
          );
          return;
        }
        ledger.setThreadChat(threadId, session.chatId);
        const thread = (await comments.threads(path)).find((t) => t.id === threadId);
        if (!thread) return;
        const doc = documents.peek(path) ?? (await vault.read(path));
        const line = (pos: number) => doc.slice(0, pos).split('\n').length;
        const where = thread.range
          ? ` (line${line(thread.range.from) === line(thread.range.to) ? ` ${line(thread.range.from)}` : `s ${line(thread.range.from)}–${line(thread.range.to)}`})`
          : '';
        const conversation = thread.comments
          .filter((c) => c.id !== placeholder.id)
          .map((c) => `${c.author}: ${c.body}`)
          .join('\n');
        const prompt = [
          `You were mentioned in a comment thread on the note \`${path}\`.`,
          `The comment is attached to this text${where}:\n> ${thread.anchor.exact.replace(/\n/g, '\n> ') || '(no text)'}`,
          `Thread:\n${conversation}`,
          'Answer the latest comment. If it asks for a change to the note, make the change, then say briefly what you did. Your final message is posted as your reply in the thread, so keep it short and do not repeat the question.',
        ].join('\n\n');

        // The chat may not be on screen: approvals for this answer are asked in a dialog.
        const asked = new Set<number>();
        let approvals: { dispose(): void } | undefined;
        const watchApprovals = () => {
          for (const item of session.items) if (item.kind === 'permission') asked.add(item.id);
          approvals = session.onDidChange(() => {
            for (const item of session.items) {
              if (item.kind !== 'permission' || item.chosen || asked.has(item.id)) continue;
              asked.add(item.id);
              void workspace
                .confirm(`${who} wants to: ${item.title}`, { confirmLabel: 'Allow' })
                .then((ok) => {
                  const pick = item.options.find((o) =>
                    ok ? o.kind === 'allow_once' : o.kind === 'reject_once',
                  );
                  item.respond?.(
                    pick?.optionId ?? (ok ? (item.options[0]?.optionId ?? null) : null),
                  );
                });
            }
          });
        };
        let produced;
        try {
          // A busy chat finishes what it is doing first: the comment waits in its queue.
          produced = await manager.ask(chat, {
            message: prompt,
            blocks: [{ type: 'resource_link', uri: fileUri(path), name: path }],
            label: `Comment on ${path}`,
            started: () => {
              watchApprovals();
              void finish('Working on it…');
            },
          });
        } finally {
          approvals?.dispose();
        }
        const answer = produced
          .flatMap((i) => (i.kind === 'agent' ? [i.text.trim()] : []))
          .filter(Boolean)
          .join('\n\n');
        const problem = produced.flatMap((i) => (i.kind === 'error' ? [i.text] : [])).join('\n');
        await finish(answer || (problem ? `Could not answer: ${problem}` : 'Done.'));
      } catch (e) {
        await finish(`Could not answer: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    ctx.provide(Agents, {
      available: () => agents().length > 0 && !!root,
      replyToComment,
      mentions,
      answers: (threadId) => !!ledger.threadChat(threadId),
      recipient: async (r) => describe(await resolve(r.path, r.threadId, r.range, r.mention)),
      registerGuidance: (text) => {
        guidanceSources.add(text);
        return { dispose: () => void guidanceSources.delete(text) };
      },
    });

    ctx.commands.register({
      id: 'agents.ask',
      title: 'Ask agent about selection',
      category: 'Agents',
      hotkeys: ['Mod+Alt+A'],
      run: ask,
    });
    ctx.commands.register({
      id: 'agents.open',
      title: 'Open agent chat',
      category: 'Agents',
      run: showPanel,
    });
    ctx.register(
      editor.registerContextMenuItem({
        id: 'agents.ask',
        label: 'Ask agent about selection',
        icon: 'bot',
        order: 11,
        when: (v) => !v.state.selection.main.empty,
        run: () => ask(),
      }),
    );

    const settingsUi = ctx.tryUse(SettingsUi);
    if (settingsUi) {
      ctx.register(
        settingsUi.registerTab({
          id: 'agents',
          title: 'Agents',
          group: 'plugins',
          render(container) {
            const overrides = { ...ctx.settings.get<Record<string, string>>('commands', {}) };
            const rows = DEFAULT_AGENTS.filter((a) => a.kind !== 'chatgpt').map((a) => {
              const status = h('span', { class: 'pm-agent-install' });
              const check = async () => {
                const cmd = splitCommand(overrides[a.id]?.trim() || joinCommand(a))[0]!;
                if (!host) return;
                const found = await host.which(cmd);
                status.textContent = found ? `✓ ${cmd} found` : `✗ ${cmd} not found`;
                status.dataset.ok = String(!!found);
              };
              void check();
              return settingItem(
                a.name,
                h('span', {}, a.setupHint ?? '', h('br'), status),
                textInput(overrides[a.id] || joinCommand(a), (v) => {
                  const value = v.trim();
                  if (!value || value === joinCommand(a)) delete overrides[a.id];
                  else overrides[a.id] = value;
                  void ctx.settings.set('commands', { ...overrides });
                  void check();
                }),
              );
            });
            container.replaceChildren(
              h('h2', {}, 'Agents'),
              h(
                'p',
                { class: 'pm-setting-note' },
                'The ChatGPT assistant is built in. The other agents are programs on this computer (Agent Client Protocol), signed in with your own account; the first time one starts, Pumice asks before running its command.',
              ),
              ...(platform.chatgpt
                ? [
                    chatgptRow(platform.chatgpt),
                    settingItem(
                      'Web access for the ChatGPT assistant',
                      'Lets it search the web and read pages. Searches go to DuckDuckGo; before the first page of a website is opened, it asks. The other agents use their own tools and settings.',
                      toggle(
                        ctx.settings.get('webAccess', true),
                        (on) => void ctx.settings.set('webAccess', on),
                        { label: 'Web access for the ChatGPT assistant' },
                      ),
                    ),
                    settingItem(
                      'Ask before opening a website',
                      'On: it asks before the first page of each website (you can allow a site, or all sites, for a chat). Off: it opens pages and downloads without asking about the website. Saving a file into the vault still follows the chat’s mode.',
                      toggle(
                        ctx.settings.get('webAsk', true),
                        (on) => void ctx.settings.set('webAsk', on),
                        { label: 'Ask before opening a website' },
                      ),
                    ),
                  ]
                : []),
              ...(host ? rows : [h('p', {}, 'Agents need the desktop app.')]),
              settingItem(
                'Reset commands',
                'Go back to the default command for every agent.',
                button('Reset', () => {
                  void ctx.settings.set('commands', {});
                  void settingsUi.open('agents');
                }),
              ),
            );
          },
        }),
      );
    }
  },
});

export default { manifest, plugin } satisfies PluginModule;
