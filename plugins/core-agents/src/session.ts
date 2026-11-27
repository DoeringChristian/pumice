import { newChatId, transcriptText, type ChatSnapshot, type SavedChat } from './chats';
import {
  PROTOCOL_VERSION,
  client as acpClient,
  ndJsonStream,
  type ClientConnection,
  type ContentBlock,
  type McpServer,
  type SessionConfigOption,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallContent,
} from '@agentclientprotocol/sdk';
import {
  McpOverAcpProvider,
  type McpMessageParams,
  type McpServerAcpDeclaration,
} from '@agentclientprotocol/sdk/unstable';
import { NOTE_TOOLS, noteTools, toolsGuidance } from './note-tools';
import type { VaultToolContext } from './vault-tools';
import { Emitter, type ChildProcessHandle, type ProcessHost, type VaultPath } from '@pumice/api';

/** A configured agent command (docs/plan/09). */
export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Shown when the command isn't installed or the agent asks for a login. */
  setupHint?: string;
  /** `chatgpt`: the built-in assistant on the user's ChatGPT plan (no program to run). */
  kind?: 'acp' | 'chatgpt';
  /** It runs on the vault's server, in chats the server keeps (docs/plan/11). */
  server?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** What may follow the command, e.g. "what to focus on". */
  hint?: string;
}

/** What the chat panel needs from a running agent, whatever is behind it. */
export interface ChatSession {
  readonly config: AgentConfig;
  /** Id under which the conversation is saved. */
  readonly chatId: string;
  /** What is needed to show the conversation again and continue it. */
  snapshot(): ChatSnapshot;
  readonly items: TranscriptItem[];
  status: SessionStatus;
  modes: Array<{ id: string; name: string }>;
  currentMode: string | undefined;
  /** Models to choose from (empty: the agent decides). */
  models: Array<{ id: string; name: string }>;
  currentModel: string | undefined;
  /** How hard the model thinks, where it can be chosen (absent or empty: it cannot). */
  efforts?: Array<{ id: string; name: string }>;
  currentEffort?: string | undefined;
  setEffort?(effortId: string): Promise<void>;
  readonly onDidChange: (listener: () => void) => { dispose(): void };
  /** Slash commands the agent understands (typed as `/name` at the start of a message). */
  commands: SlashCommand[];
  /** Sign-in buttons to offer while `status` is `error`. */
  readonly loginOptions: Array<{ id: string; name: string }>;
  start(): Promise<void>;
  authenticate(methodId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  /**
   * Whether the chat answers the agent's questions itself with "allow" (absent: it cannot).
   * Agents of the built-in kind have their own modes for it.
   */
  autoApprove?: boolean;
  setAutoApprove?(on: boolean): void;
  /** `by`: who sent it, where several people prompt one chat (a server's). */
  prompt(text: string, context?: ContentBlock[], contextLabel?: string, by?: string): Promise<void>;
  cancel(): void;
  dispose(): void;
}

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT (your plan)',
    kind: 'chatgpt',
    command: '',
    args: [],
    setupHint: 'Uses your ChatGPT subscription through "Sign in with ChatGPT". Nothing to install.',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    setupHint:
      'Needs Node.js and a Claude login: run `claude` once in a terminal and sign in (Claude subscription or API key).',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
    setupHint:
      'Needs Node.js and a Codex login: run `codex login` once in a terminal (ChatGPT subscription or API key).',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    setupHint:
      'Install the Gemini CLI (`npm i -g @google/gemini-cli`) and sign in by running `gemini` once.',
  },
];

/** Note access for the agent's file requests; edits to open notes merge into their documents. */
export interface AgentFiles {
  /** Absolute vault folder (agents speak absolute paths). */
  root: string;
  read(path: VaultPath): Promise<string>;
  /**
   * Writes `content`. With `base` (what the writer read before), it is merged with what
   * changed since (three versions); a change at the same place is refused (StaleEditError).
   * Resolves with the text now there.
   */
  write(path: VaultPath, content: string, base?: string): Promise<string | void>;
}

// ---- transcript ------------------------------------------------------------------------------

export type TranscriptItem =
  | { kind: 'user'; id: number; text: string; context?: string; by?: string }
  | { kind: 'agent'; id: number; text: string }
  | { kind: 'thought'; id: number; text: string }
  | {
      kind: 'tool';
      id: number;
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: string;
      content: ToolCallContent[];
      locations: string[];
    }
  | {
      kind: 'plan';
      id: number;
      entries: Array<{ content: string; status: string; priority?: string }>;
    }
  | {
      kind: 'permission';
      id: number;
      title: string;
      options: PermissionOption[];
      /** Set once answered. */
      chosen?: string;
      respond?: (optionId: string | null) => void;
    }
  | { kind: 'error'; id: number; text: string }
  | { kind: 'info'; id: number; text: string };

/** A transcript item before it gets its id (Omit distributed over the union). */
type NewItem = TranscriptItem extends infer T ? (T extends unknown ? Omit<T, 'id'> : never) : never;

export type SessionStatus = 'starting' | 'ready' | 'working' | 'closed' | 'error';

const toPath = (root: string, abs: string): VaultPath => {
  const norm = abs.replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === base || !norm.startsWith(`${base}/`)) throw new Error(`Outside the vault: ${abs}`);
  return norm.slice(base.length + 1);
};

let nextItemId = 1;

/** One running agent and its conversation. */
export class AgentSession implements ChatSession {
  /** Chosen through the agent's configuration options (ACP), where it has them for these. */
  models: Array<{ id: string; name: string }> = [];
  currentModel: string | undefined;
  efforts: Array<{ id: string; name: string }> = [];
  currentEffort: string | undefined;
  /** The ids of the agent's options for the model and the effort. */
  private modelOption: string | undefined;
  private effortOption: string | undefined;

  async setModel(modelId: string): Promise<void> {
    await this.setOption(this.modelOption, modelId);
  }

  async setEffort(effortId: string): Promise<void> {
    await this.setOption(this.effortOption, effortId);
  }

  private async setOption(configId: string | undefined, value: string): Promise<void> {
    if (!this.conn || !this.sessionId || !configId) return;
    const res = await this.conn.agent.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId,
      value,
    });
    this.applyOptions(res.configOptions);
  }

  /** The agent's configuration options: its model and effort, where it has them. */
  private applyOptions(options: SessionConfigOption[] | null | undefined): void {
    if (!options) return;
    const select = (category: string) => {
      const o = options.find((c) => c.category === category && c.type === 'select');
      if (!o || o.type !== 'select') return undefined;
      const values = o.options.flatMap((v) => ('group' in v ? v.options : [v]));
      return {
        id: o.id,
        current: o.currentValue,
        values: values.map((v) => ({ id: v.value, name: v.name })),
      };
    };
    const model = select('model');
    const effort = select('thought_level');
    this.modelOption = model?.id;
    this.models = model?.values ?? [];
    this.currentModel = model?.current;
    this.effortOption = effort?.id;
    this.efforts = effort?.values ?? [];
    this.currentEffort = effort?.current;
    this.changed.fire();
  }

  /** What was chosen in the chat before, again (an agent starts with its defaults). */
  private async restoreChoices(): Promise<void> {
    const { model, effort } = this.saved ?? {};
    try {
      if (model && model !== this.currentModel && this.models.some((m) => m.id === model))
        await this.setModel(model);
      if (effort && effort !== this.currentEffort && this.efforts.some((e) => e.id === effort))
        await this.setEffort(effort);
    } catch {
      // (Its own defaults, then.)
    }
  }
  /** Announced by the agent (`available_commands_update`); sent to it as ordinary prompts. */
  commands: SlashCommand[] = [];

  readonly items: TranscriptItem[] = [];
  status: SessionStatus = 'starting';
  /** Diagnostics from the agent process (stderr), for the "details" view. */
  log = '';
  modes: Array<{ id: string; name: string }> = [];
  currentMode: string | undefined;
  private conn: ClientConnection | undefined;
  private proc: ChildProcessHandle | undefined;
  private sessionId: string | undefined;
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private authMethods: Array<{ id: string; name: string; description?: string | null }> = [];
  /** Pumice's note tools, where the agent takes MCP servers over ACP (note-tools.ts). */
  private tools: { declaration: McpServerAcpDeclaration; dispose(): void } | undefined;

  constructor(
    readonly config: AgentConfig,
    private readonly host: ProcessHost,
    private readonly files: AgentFiles,
    /** Standing guidance about the app, given with the first message of a conversation. */
    private readonly guidance: () => string = () => '',
    /** A conversation to pick up again. */
    private readonly saved?: SavedChat,
    /** The id of a new chat (made by whoever keeps it). */
    chatId?: string,
    /**
     * The vault, its index and drawings, for the vault's tools offered to the agent (MCP over ACP,
     * note-tools.ts); absent: none are offered.
     */
    private readonly vaultContext?: () => Omit<VaultToolContext, 'files'>,
  ) {
    this.chatId = saved?.id ?? chatId ?? newChatId();
    if (saved) {
      for (const item of saved.items) this.items.push({ ...item, id: nextItemId++ });
      // The agent was told about the app when the conversation began.
      this.briefed = true;
      this.autoApprove = !!saved.autoApprove;
    }
  }

  readonly chatId: string;
  /** While the agent replays a loaded conversation (it is already on screen). */
  private replaying = false;

  snapshot(): ChatSnapshot {
    return {
      items: this.items,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.autoApprove ? { autoApprove: true } : {}),
      ...(this.currentModel ? { model: this.currentModel } : {}),
      ...(this.currentEffort ? { effort: this.currentEffort } : {}),
    };
  }

  autoApprove = false;
  setAutoApprove(on: boolean): void {
    this.autoApprove = on;
    // A question waiting now is answered too.
    if (on)
      for (const item of this.items)
        if (item.kind === 'permission' && !item.chosen) {
          const allow = allowOption(item.options);
          if (allow) item.respond?.(allow);
        }
    this.changed.fire();
  }

  private briefed = false;
  /** The conversation a fork continues, given to the agent with its first message. */
  private earlier = '';

  private push(item: NewItem): TranscriptItem {
    const full = { ...item, id: nextItemId++ } as TranscriptItem;
    this.items.push(full);
    this.changed.fire();
    return full;
  }

  private setStatus(s: SessionStatus) {
    this.status = s;
    this.changed.fire();
  }

  async start(): Promise<void> {
    try {
      this.proc = await this.host.spawn(this.config.command, this.config.args);
    } catch (e) {
      if (this.disposed) return;
      this.fail(e);
      return;
    }
    // Disposed while the program started: it goes again at once.
    if (this.disposed) {
      this.proc.kill();
      return;
    }
    this.proc.onStderr((t) => {
      this.log = (this.log + t).slice(-20000);
    });
    void this.proc.exited.then((code) => {
      if (this.status === 'closed') return;
      this.push({
        kind: 'error',
        text: `The agent exited${code === null ? '' : ` (code ${code})`}.${this.config.setupHint ? ` ${this.config.setupHint}` : ''}`,
      });
      this.setStatus('closed');
    });

    const mcp = new McpOverAcpProvider();
    const app = acpClient({ name: 'pumice' })
      // (Pumice's note tools: MCP over this connection. The provider checks the envelope.)
      .onRequest('mcp/message', (params) => params as McpMessageParams, mcp.handleRequest)
      .onNotification('session/update', ({ params }) => this.onUpdate(params))
      .onRequest('session/request_permission', ({ params }) =>
        this.askPermission(params.toolCall.title ?? 'The agent wants to continue', params.options),
      )
      .onRequest('fs/read_text_file', async ({ params }) => {
        let text = await this.files.read(toPath(this.files.root, params.path));
        if (params.line || params.limit) {
          const lines = text.split('\n');
          const start = Math.max(0, (params.line ?? 1) - 1);
          text = lines.slice(start, params.limit ? start + params.limit : undefined).join('\n');
        }
        return { content: text };
      })
      .onRequest('fs/write_text_file', async ({ params }) => {
        await this.files.write(toPath(this.files.root, params.path), params.content);
        return {};
      });
    this.conn = app.connect(ndJsonStream(this.proc.stdin, this.proc.stdout));

    try {
      const init = await this.conn.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'Pumice', version: '0.1.0' },
      });
      this.authMethods = init.authMethods ?? [];
      // Notes through Pumice, for an agent that takes tools over this connection.
      const capabilities = init.agentCapabilities?.mcpCapabilities as { acp?: boolean } | undefined;
      if (capabilities?.acp && this.vaultContext) {
        const adapter = noteTools(this.toolContext);
        const registration = mcp.registerServer(this.conn.agent, {
          name: NOTE_TOOLS,
          handler: adapter.handler,
        });
        this.tools = {
          declaration: registration.declaration,
          dispose: () => {
            void registration.dispose();
            void adapter.close();
          },
        };
      }
      if (this.saved?.forkedFrom && !this.saved.sessionId) {
        // A fork: the agent starts anew and is told what was said, with the next message.
        this.earlier = transcriptText(this.saved.items);
        this.briefed = false;
      } else if (this.saved && !(await this.resume(!!init.agentCapabilities?.loadSession))) {
        this.push({
          kind: 'info',
          text: `${this.config.name} could not pick this conversation up again. The messages above are kept, but it does not remember them: say what it needs to know.`,
        });
        this.briefed = false;
      }
      if (!this.sessionId) await this.newSession();
      if (this.sessionId) await this.restoreChoices();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Asks the agent to continue the saved conversation. False if it cannot. */
  private async resume(supported: boolean): Promise<boolean> {
    if (!supported || !this.saved?.sessionId) return false;
    this.replaying = true;
    try {
      const res = await this.conn!.agent.request('session/load', {
        sessionId: this.saved.sessionId,
        cwd: this.files.root,
        mcpServers: this.mcpServers(),
      });
      this.sessionId = this.saved.sessionId;
      this.modes = res?.modes?.availableModes.map((m) => ({ id: m.id, name: m.name })) ?? [];
      this.currentMode = res?.modes?.currentModeId;
      this.applyOptions(res?.configOptions);
      this.setStatus('ready');
      return true;
    } catch {
      return false;
    } finally {
      this.replaying = false;
    }
  }

  private async newSession(): Promise<void> {
    try {
      const res = await this.conn!.agent.request('session/new', {
        cwd: this.files.root,
        mcpServers: this.mcpServers(),
      });
      this.sessionId = res.sessionId;
      this.modes = res.modes?.availableModes.map((m) => ({ id: m.id, name: m.name })) ?? [];
      this.currentMode = res.modes?.currentModeId;
      this.applyOptions(res.configOptions);
      this.setStatus('ready');
    } catch (e) {
      if (isAuthRequired(e) && this.authMethods.length) {
        this.push({
          kind: 'info',
          text: `${this.config.name} needs you to sign in. ${this.config.setupHint ?? ''}`.trim(),
        });
        this.setStatus('error');
        return;
      }
      throw e;
    }
  }

  /** (An `acp` server is newer than the stable schema's list of kinds.) */
  private readonly toolContext = (): VaultToolContext => ({
    ...this.vaultContext!(),
    files: this.files,
  });

  private mcpServers(): McpServer[] {
    return this.tools ? [this.tools.declaration as unknown as McpServer] : [];
  }

  /** Sign-in methods the agent offers (after an auth error). */
  get loginOptions() {
    return this.authMethods;
  }

  async authenticate(methodId: string): Promise<void> {
    if (!this.conn) return;
    this.setStatus('starting');
    try {
      await this.conn.agent.request('authenticate', { methodId });
      await this.newSession();
    } catch (e) {
      this.fail(e);
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    await this.conn.agent.request('session/set_mode', { sessionId: this.sessionId, modeId });
    this.currentMode = modeId;
    this.changed.fire();
  }

  /** Sends a prompt; resolves when the agent's turn ends. */
  async prompt(
    text: string,
    context: ContentBlock[] = [],
    contextLabel?: string,
    by?: string,
  ): Promise<void> {
    if (!this.conn || !this.sessionId || this.status === 'working') return;
    this.push({
      kind: 'user',
      text,
      ...(contextLabel ? { context: contextLabel } : {}),
      ...(by ? { by } : {}),
    });
    this.setStatus('working');
    const about = this.briefed
      ? ''
      : [this.tools ? toolsGuidance(this.toolContext()) : '', this.guidance()]
          .filter(Boolean)
          .join('\n\n');
    this.briefed = true;
    const earlier = this.earlier;
    this.earlier = '';
    try {
      const res = await this.conn.agent.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [
          ...(earlier
            ? [
                {
                  type: 'text' as const,
                  text: `This conversation continues an earlier one. What was said there (background, not a request):\n${earlier}`,
                },
              ]
            : []),
          ...(about
            ? [
                {
                  type: 'text' as const,
                  text: `About Pumice, the note app this conversation runs in (background, not a request):\n${about}`,
                },
              ]
            : []),
          ...context,
          { type: 'text', text },
        ],
      });
      if (res.stopReason === 'refusal') this.push({ kind: 'info', text: 'The agent declined.' });
      else if (res.stopReason === 'max_tokens' || res.stopReason === 'max_turn_requests')
        this.push({ kind: 'info', text: 'The agent stopped (limit reached).' });
      this.setStatus('ready');
    } catch (e) {
      this.fail(e, true);
    }
  }

  cancel(): void {
    if (!this.conn || !this.sessionId) return;
    void this.conn.agent.notify('session/cancel', { sessionId: this.sessionId });
    // Pending permission prompts are cancelled with the turn.
    for (const item of this.items) {
      if (item.kind === 'permission' && !item.chosen) item.respond?.(null);
    }
  }

  private disposed = false;

  dispose(): void {
    this.disposed = true;
    this.status = 'closed';
    this.tools?.dispose();
    this.conn?.close();
    this.proc?.kill();
    this.changed.dispose();
  }

  private fail(e: unknown, recoverable = false) {
    this.push({ kind: 'error', text: errorText(e) });
    this.setStatus(recoverable && this.proc ? 'ready' : 'error');
  }

  private askPermission(
    title: string,
    options: PermissionOption[],
  ): Promise<RequestPermissionResponse> {
    const allow = this.autoApprove ? allowOption(options) : undefined;
    if (allow) {
      // Answered by the chat itself: shown as answered.
      this.push({ kind: 'permission', title, options, chosen: allow });
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow } });
    }
    return new Promise((resolve) => {
      // The answer callback must exist before listeners hear about the prompt.
      let item: Extract<TranscriptItem, { kind: 'permission' }> | undefined;
      const respond = (optionId: string | null) => {
        if (!item || item.chosen) return;
        item.chosen = optionId ?? 'cancelled';
        this.changed.fire();
        resolve(
          optionId
            ? { outcome: { outcome: 'selected', optionId } }
            : { outcome: { outcome: 'cancelled' } },
        );
      };
      item = { kind: 'permission', id: nextItemId++, title, options, respond };
      this.items.push(item);
      this.changed.fire();
    });
  }

  private lastOf<K extends TranscriptItem['kind']>(kind: K) {
    const last = this.items[this.items.length - 1];
    return last?.kind === kind ? (last as Extract<TranscriptItem, { kind: K }>) : undefined;
  }

  private onUpdate(n: SessionNotification): void {
    const u = n.update;
    // A loaded conversation is replayed by the agent; it is already shown.
    if (
      this.replaying &&
      u.sessionUpdate !== 'available_commands_update' &&
      u.sessionUpdate !== 'current_mode_update' &&
      u.sessionUpdate !== 'config_option_update'
    )
      return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const kind = u.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought';
        const text =
          u.content.type === 'text'
            ? u.content.text
            : u.content.type === 'resource_link'
              ? `[${u.content.name}](${u.content.uri})`
              : '';
        const last = this.lastOf(kind);
        if (last) last.text += text;
        else this.push({ kind, text });
        break;
      }
      case 'tool_call': {
        this.push({
          kind: 'tool',
          toolCallId: u.toolCallId,
          title: u.title,
          ...(u.kind ? { toolKind: u.kind } : {}),
          status: u.status ?? 'pending',
          content: u.content ?? [],
          locations: (u.locations ?? []).map((l) => l.path),
        });
        break;
      }
      case 'tool_call_update': {
        const item = [...this.items]
          .reverse()
          .find(
            (i): i is Extract<TranscriptItem, { kind: 'tool' }> =>
              i.kind === 'tool' && i.toolCallId === u.toolCallId,
          );
        if (!item) break;
        if (u.title) item.title = u.title;
        if (u.status) item.status = u.status;
        if (u.content) item.content = u.content;
        if (u.locations) item.locations = u.locations.map((l) => l.path);
        break;
      }
      case 'plan': {
        const last = [...this.items].reverse().find((i) => i.kind === 'plan');
        const entries = u.entries.map((e) => ({
          content: e.content,
          status: e.status,
          priority: e.priority,
        }));
        if (last && last.kind === 'plan') last.entries = entries;
        else this.push({ kind: 'plan', entries });
        break;
      }
      case 'available_commands_update':
        this.commands = u.availableCommands.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.input && 'hint' in c.input && c.input.hint ? { hint: c.input.hint } : {}),
        }));
        break;
      case 'config_option_update':
        this.applyOptions(u.configOptions);
        break;
      case 'current_mode_update':
        this.currentMode = u.currentModeId;
        break;
      default:
        break;
    }
    this.changed.fire();
  }
}

/**
 * The option that allows what the agent asks, this once (an "always" may become a rule of the
 * agent's beyond this chat).
 */
export function allowOption(options: PermissionOption[]): string | undefined {
  return (
    options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
  )?.optionId;
}

function isAuthRequired(e: unknown): boolean {
  const code =
    typeof e === 'object' && e && 'code' in e ? (e as { code: unknown }).code : undefined;
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === 'object' && e && 'message' in e
        ? String((e as { message: unknown }).message)
        : '';
  return code === -32000 || /auth/i.test(msg);
}

/** Vault-relative path of an absolute path reported by the agent, or the path itself. */
export function vaultPathOf(root: string, abs: string): string {
  try {
    return toPath(root, abs);
  } catch {
    return abs;
  }
}

/**
 * The most useful text in an error. Agents often answer "Internal error" and put the reason
 * (sometimes as JSON from their provider) in the error's data.
 */
export function errorText(e: unknown): string {
  const obj = (typeof e === 'object' && e ? e : {}) as { message?: unknown; data?: unknown };
  const base = typeof obj.message === 'string' ? obj.message : String(e);
  const data = obj.data as { message?: unknown } | string | undefined;
  let detail =
    typeof data === 'string' ? data : typeof data?.message === 'string' ? data.message : '';
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string }; message?: string };
    detail = parsed.error?.message ?? parsed.message ?? detail;
  } catch {
    // not JSON: use as is
  }
  return detail && detail !== base ? `${detail}` : base;
}
