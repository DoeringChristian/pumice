import {
  Documents,
  Editor,
  MetadataIndex,
  MarkdownSyntax,
  PlatformService,
  SettingsUi,
  Vault,
  Workspace,
  definePlugin,
  markdownText,
  type ChatGptHost,
  type PluginModule,
  type VaultPath,
} from '@pumice/api';
import { button, h, settingItem, textInput } from '@pumice/ui';
import '@pumice/ui/panel.css';
import manifestJson from '../manifest.json';
import { AgentPanelState, renderAgentPanel, type Attachment } from './panel';
import { ChatGptSession } from './chatgpt-session';
import {
  AgentSession,
  DEFAULT_AGENTS,
  type AgentConfig,
  type AgentFiles,
  type ChatSession,
} from './session';
import './agents.css';

export const manifest = manifestJson;
export { AgentSession, DEFAULT_AGENTS } from './session';

/** Splits a command line into words (double quotes group). */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g))
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!);
  return out;
}

const joinCommand = (c: AgentConfig) =>
  [c.command, ...c.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

/** Smallest single replacement turning `a` into `b`. */
function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

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
    const host = platform.process;
    const root = platform.vaultRoot ?? '';

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

    /** Agent file access: open notes are edited in their documents, so changes merge live. */
    const files: AgentFiles = {
      root,
      read: async (path) => documents.peek(path) ?? (await vault.read(path)),
      async write(path, content) {
        const exists = !!vault.get(path);
        if (exists && /\.(md|markdown|txt)$/i.test(path)) {
          const handle = await documents.open(path);
          try {
            const ytext = markdownText(handle.doc);
            const change = minimalChange(ytext.toString(), content);
            if (change) {
              handle.doc.transact(() => {
                if (change.to > change.from) ytext.delete(change.from, change.to - change.from);
                if (change.insert) ytext.insert(change.from, change.insert);
              }, 'agent');
            }
          } finally {
            handle.dispose();
          }
        } else {
          await vault.write(path, content);
        }
      },
    };

    const sessions = new Map<string, ChatSession>();
    ctx.register(() => sessions.forEach((s) => s.dispose()));
    const startSession = (agentId: string) => {
      sessions.get(agentId)?.dispose();
      const config = agents().find((a) => a.id === agentId) ?? agents()[0]!;
      const s: ChatSession =
        config.kind === 'chatgpt'
          ? new ChatGptSession(config, {
              host: platform.chatgpt!,
              files,
              index: ctx.use(MetadataIndex),
              vault,
              savedModel: () => ctx.settings.get<string | undefined>('chatgptModel', undefined),
              saveModel: (id) => void ctx.settings.set('chatgptModel', id),
              savedMode: () => ctx.settings.get<string | undefined>('chatgptMode', undefined),
              saveMode: (id) => void ctx.settings.set('chatgptMode', id),
            })
          : new AgentSession(config, host!, files);
      sessions.set(agentId, s);
      void s.start();
      return s;
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
              agents,
              available: (!!host || !!platform.chatgpt) && !!root,
              root,
              sessionFor: (id) => sessions.get(id),
              startSession,
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
              ...(platform.chatgpt ? [chatgptRow(platform.chatgpt)] : []),
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
