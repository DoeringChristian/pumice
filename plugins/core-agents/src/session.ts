import {
  PROTOCOL_VERSION,
  client as acpClient,
  ndJsonStream,
  type ClientConnection,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallContent,
} from '@agentclientprotocol/sdk';
import { Emitter, type ChildProcessHandle, type ProcessHost, type VaultPath } from '@pumice/api';

/** A configured agent command (docs/plan/09). */
export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Shown when the command isn't installed or the agent asks for a login. */
  setupHint?: string;
}

export const DEFAULT_AGENTS: AgentConfig[] = [
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
  write(path: VaultPath, content: string): Promise<void>;
}

// ---- transcript ------------------------------------------------------------------------------

export type TranscriptItem =
  | { kind: 'user'; id: number; text: string; context?: string }
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
export class AgentSession {
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

  constructor(
    readonly config: AgentConfig,
    private readonly host: ProcessHost,
    private readonly files: AgentFiles,
  ) {}

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
      this.fail(e);
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

    const app = acpClient({ name: 'pumice' })
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
      await this.newSession();
    } catch (e) {
      this.fail(e);
    }
  }

  private async newSession(): Promise<void> {
    try {
      const res = await this.conn!.agent.request('session/new', {
        cwd: this.files.root,
        mcpServers: [],
      });
      this.sessionId = res.sessionId;
      this.modes = res.modes?.availableModes.map((m) => ({ id: m.id, name: m.name })) ?? [];
      this.currentMode = res.modes?.currentModeId;
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
  async prompt(text: string, context: ContentBlock[] = [], contextLabel?: string): Promise<void> {
    if (!this.conn || !this.sessionId || this.status === 'working') return;
    this.push({ kind: 'user', text, ...(contextLabel ? { context: contextLabel } : {}) });
    this.setStatus('working');
    try {
      const res = await this.conn.agent.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [...context, { type: 'text', text }],
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

  dispose(): void {
    this.status = 'closed';
    this.conn?.close();
    this.proc?.kill();
    this.changed.dispose();
  }

  private fail(e: unknown, recoverable = false) {
    const msg =
      e instanceof Error
        ? e.message
        : typeof e === 'object' && e && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e);
    this.push({ kind: 'error', text: msg });
    this.setStatus(recoverable && this.proc ? 'ready' : 'error');
  }

  private askPermission(
    title: string,
    options: PermissionOption[],
  ): Promise<RequestPermissionResponse> {
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
      case 'current_mode_update':
        this.currentMode = u.currentModeId;
        break;
      default:
        break;
    }
    this.changed.fire();
  }
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
