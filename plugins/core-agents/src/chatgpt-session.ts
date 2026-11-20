import type { ContentBlock, PermissionOption } from '@agentclientprotocol/sdk';
import {
  Emitter,
  type ChatGptHost,
  type MetadataIndexApi,
  type VaultApi,
  type VaultPath,
} from '@pumice/api';
import type {
  AgentConfig,
  AgentFiles,
  ChatSession,
  SlashCommand,
  SessionStatus,
  TranscriptItem,
} from './session';

/**
 * The built-in assistant on the user's ChatGPT plan ("Sign in with ChatGPT", docs/plan/09).
 * There is no agent program: this is the agent loop, calling OpenAI's Responses API through the
 * app shell and working on the vault with the tools below.
 */

type Item = Record<string, unknown>;

export interface ChatGptSessionDeps {
  host: ChatGptHost;
  files: AgentFiles;
  index: MetadataIndexApi;
  vault: VaultApi;
  /** Last model the user chose. */
  savedModel(): string | undefined;
  saveModel(id: string): void;
  savedMode(): string | undefined;
  saveMode(id: string): void;
  /** Standing guidance other plugins added (how features of the app are used). */
  guidance?(): string;
}

const MODES = [
  { id: 'ask', name: 'Ask before editing' },
  { id: 'auto', name: 'Edit without asking' },
  { id: 'read', name: 'Read only' },
];

const INSTRUCTIONS = `You are the assistant inside Pumice, a note-taking app. You work in the user's vault: a folder of Markdown notes in Obsidian's dialect (wikilinks like [[Note name]], [[Note#Heading]], embeds ![[Note]], #tags, YAML frontmatter, callouts, tasks).

Use the tools to look things up before answering questions about the notes; do not guess their contents. Paths are relative to the vault, with forward slashes, e.g. "Projects/Plan.md".
When you change notes, make small, exact edits with edit_note and keep the user's wording and formatting elsewhere. Link to other notes with [[Name]] wikilinks. Answer in Markdown, briefly.`;

const TOOLS: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [
  {
    name: 'list_notes',
    description: 'Lists files in the vault (paths). Optionally only those under a folder.',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder path; omit for the whole vault.' },
      },
    },
  },
  {
    name: 'search_notes',
    description:
      'Full-text search over note titles and contents. Returns matching paths with excerpts.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'read_note',
    description: 'Reads a note (or any text file) from the vault.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'get_links',
    description: 'Lists the notes a note links to and the notes that link to it (backlinks).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'edit_note',
    description:
      'Replaces one exact piece of text in a note. old_text must occur exactly once; include enough surrounding text to make it unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'create_note',
    description:
      "Creates a new text file: a note (Markdown), or another file such as a frame's HTML or a JSON data file. Fails if the file exists.",
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
];

const WRITE_TOOLS = new Set(['edit_note', 'create_note']);
const MAX_READ = 60_000;
const MAX_STEPS = 40;

const PLAN_ERRORS: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded:
    'You have reached this app’s ChatGPT plan limit. Raise it in ChatGPT settings (Usage & Billing → App limits) or wait for it to reset.',
  subscription_sharing_user_not_eligible: 'This ChatGPT account cannot share its plan with apps.',
  subscription_sharing_usage_unavailable:
    'ChatGPT plan usage is unavailable right now. Try again shortly.',
  subscription_sharing_user_unavailable:
    'ChatGPT plan usage is unavailable right now. Try again shortly.',
  subscription_sharing_unsupported_capability:
    'The ChatGPT plan does not support part of this request.',
  subscription_sharing_route_not_supported: 'The ChatGPT plan does not support this request.',
  subscription_sharing_invalid_user: 'Your ChatGPT sign-in is no longer valid. Sign in again.',
  chatpass_v2_scope_not_authorized:
    'Plan usage was not allowed at sign-in. Sign in again and allow it.',
  chatpass_v2_invalid_authorization_context:
    'Your ChatGPT sign-in is no longer valid. Sign in again.',
};

class TurnError extends Error {
  constructor(
    message: string,
    readonly needsSignIn = false,
  ) {
    super(message);
  }
}

/** A readable error from a failed request or a streamed error event. */
function providerError(status: number, body: unknown): TurnError {
  const b = (body ?? {}) as {
    error?: { code?: string; type?: string; message?: string } | string;
    detail?: string;
    code?: string;
    message?: string;
  };
  const nested = typeof b.error === 'object' && b.error ? b.error : {};
  const code = nested.code ?? b.code ?? nested.type;
  const message = nested.message ?? b.message ?? (typeof b.error === 'string' ? b.error : b.detail);
  if (code && PLAN_ERRORS[code])
    return new TurnError(PLAN_ERRORS[code], /invalid|scope/.test(code));
  if (status === 401)
    return new TurnError(
      message || 'Your ChatGPT sign-in is no longer valid. Sign in again.',
      true,
    );
  if (status === 404) return new TurnError(message || 'Unknown model. Pick another one.');
  if (status === 429) return new TurnError(message || 'Rate limited. Wait a moment and try again.');
  const what = [code, message].filter(Boolean).join(' — ') || 'the request failed without a reason';
  return new TurnError(`OpenAI error${status ? ` ${status}` : ''}: ${what}`);
}

let nextItemId = 1_000_000;

export class ChatGptSession implements ChatSession {
  readonly items: TranscriptItem[] = [];
  status: SessionStatus = 'starting';
  modes = MODES;
  currentMode: string | undefined = 'ask';
  models: Array<{ id: string; name: string }> = [];
  currentModel: string | undefined;
  loginOptions: Array<{ id: string; name: string }> = [];
  commands: SlashCommand[] = [
    {
      name: 'compact',
      description: 'Summarize the conversation so far to free up context',
      hint: 'what to keep (optional)',
    },
    { name: 'clear', description: 'Forget the conversation and start over' },
    { name: 'help', description: 'List the commands' },
  ];
  private readonly changed = new Emitter<void>();
  readonly onDidChange = (listener: () => void) => this.changed.event(listener);
  /** The conversation as Responses API input items (resent on every request). */
  private readonly input: Item[] = [];
  private abort: AbortController | undefined;
  private disposed = false;
  /** Write tools the user allowed for the rest of this chat. */
  private readonly alwaysAllowed = new Set<string>();

  constructor(
    readonly config: AgentConfig,
    private readonly deps: ChatGptSessionDeps,
  ) {
    const mode = deps.savedMode();
    if (mode && MODES.some((m) => m.id === mode)) this.currentMode = mode;
  }

  private push(item: Record<string, unknown> & { kind: TranscriptItem['kind'] }): TranscriptItem {
    const full = { ...item, id: nextItemId++ } as TranscriptItem;
    this.items.push(full);
    this.changed.fire();
    return full;
  }

  private setStatus(status: SessionStatus) {
    this.status = status;
    this.changed.fire();
  }

  private needSignIn(message: string) {
    this.loginOptions = [{ id: 'chatgpt', name: 'Sign in with ChatGPT' }];
    this.push({ kind: 'info', text: message });
    this.setStatus('error');
  }

  async start(): Promise<void> {
    try {
      const status = await this.deps.host.status();
      if (!status.signedIn) {
        this.needSignIn(
          'Sign in with ChatGPT to use your plan here. Your browser opens OpenAI’s consent page; nothing is installed.',
        );
        return;
      }
      if (!status.planUsage) {
        this.needSignIn(
          'You are signed in, but plan usage was not allowed. Sign in again and allow it.',
        );
        return;
      }
      await this.loadModels();
      this.loginOptions = [];
      this.setStatus('ready');
    } catch (e) {
      const needs = (e as { needsSignIn?: boolean }).needsSignIn;
      if (needs) this.needSignIn(e instanceof Error ? e.message : String(e));
      else {
        this.push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
        this.setStatus('error');
      }
    }
  }

  private async loadModels(): Promise<void> {
    this.models = await this.deps.host.models();
    const saved = this.deps.savedModel();
    this.currentModel =
      (saved && this.models.some((m) => m.id === saved) ? saved : undefined) ?? this.models[0]?.id;
  }

  /** Opens the consent page and waits until the sign-in completes (or ten minutes pass). */
  async authenticate(): Promise<void> {
    this.setStatus('starting');
    try {
      await this.deps.host.login();
      const deadline = Date.now() + 10 * 60_000;
      while (!this.disposed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        if ((await this.deps.host.status()).signedIn) break;
      }
      if (this.disposed) return;
      await this.start();
    } catch (e) {
      this.push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      this.setStatus('error');
    }
  }

  async setMode(modeId: string): Promise<void> {
    this.currentMode = modeId;
    this.deps.saveMode(modeId);
    this.changed.fire();
  }

  async setModel(modelId: string): Promise<void> {
    this.currentModel = modelId;
    this.deps.saveModel(modelId);
    this.changed.fire();
  }

  cancel(): void {
    this.abort?.abort();
    for (const item of this.items) {
      if (item.kind === 'permission' && !item.chosen) item.respond?.(null);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.status = 'closed';
    this.abort?.abort();
    this.changed.dispose();
  }

  // ---- a turn --------------------------------------------------------------------------------

  async prompt(text: string, context: ContentBlock[] = [], contextLabel?: string): Promise<void> {
    if (this.status !== 'ready') return;
    const command = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (command && this.commands.some((c) => c.name === command[1]!.toLowerCase()))
      return this.runCommand(command[1]!.toLowerCase(), command[2]?.trim() ?? '');
    this.push({ kind: 'user', text, ...(contextLabel ? { context: contextLabel } : {}) });
    const parts: string[] = [];
    for (const block of context) {
      if (block.type === 'resource' && 'text' in block.resource) {
        const where = this.pathOf(block.resource.uri);
        parts.push(`<selection source="${where}">\n${block.resource.text}\n</selection>`);
      } else if (block.type === 'resource_link') {
        parts.push(`The user has the note "${block.name}" open.`);
      }
    }
    parts.push(text);
    this.input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: parts.join('\n\n') }],
    });
    this.setStatus('working');
    this.abort = new AbortController();
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const calls = await this.request(this.abort.signal);
        if (!calls.length) break;
        for (const call of calls) {
          const output = await this.runTool(call);
          this.input.push({ type: 'function_call_output', call_id: call.callId, output });
          if (this.abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        }
      }
      this.setStatus('ready');
    } catch (e) {
      if (this.disposed) return;
      if (this.abort.signal.aborted) {
        this.push({ kind: 'info', text: 'Stopped.' });
        this.setStatus('ready');
      } else if (e instanceof TurnError && e.needsSignIn) {
        this.needSignIn(e.message);
      } else if ((e as { needsSignIn?: boolean }).needsSignIn) {
        this.needSignIn(e instanceof Error ? e.message : String(e));
      } else {
        this.push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
        this.setStatus('ready');
      }
    }
  }

  // ---- slash commands -------------------------------------------------------------------------

  private async runCommand(name: string, args: string): Promise<void> {
    this.push({ kind: 'user', text: `/${name}${args ? ` ${args}` : ''}` });
    if (name === 'help') {
      this.push({
        kind: 'info',
        text: this.commands.map((c) => `/${c.name} — ${c.description}`).join('\n'),
      });
    } else if (name === 'clear') {
      this.input.length = 0;
      this.alwaysAllowed.clear();
      this.items.length = 0;
      this.push({
        kind: 'info',
        text: 'Started over. The assistant no longer knows the earlier conversation.',
      });
    } else if (name === 'compact') {
      await this.compact(args);
    }
  }

  /**
   * Replaces the conversation the model sees with a summary of it. Every request resends the
   * whole conversation, so long chats get slow and hit the plan's limits sooner.
   */
  private async compact(focus: string): Promise<void> {
    if (!this.input.length) {
      this.push({ kind: 'info', text: 'Nothing to compact yet.' });
      return;
    }
    if (!this.currentModel) return;
    this.setStatus('working');
    this.abort = new AbortController();
    let summary = '';
    let failure: TurnError | undefined;
    try {
      await this.deps.host.responses(
        {
          model: this.currentModel,
          instructions:
            'You compress conversations. Write a summary another assistant can continue from: what the user wants, what was found (note paths, facts, decisions), what was changed in which notes, and what is still open. Be complete but brief. No preamble.',
          input: [
            ...this.input,
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `Summarize our conversation so far.${focus ? ` Pay particular attention to: ${focus}` : ''}`,
                },
              ],
            },
          ],
          tool_choice: 'none',
          store: false,
          stream: true,
        },
        (event) => {
          const type = event.type as string;
          if (type === 'response.output_text.delta' && typeof event.delta === 'string')
            summary += event.delta;
          else if (type === 'response.failed')
            failure = providerError(0, { error: (event.response as { error?: unknown })?.error });
          else if (type === 'error') failure = providerError(0, event);
          else if (type === 'http_error')
            failure = providerError(Number(event.status) || 0, event.body);
        },
        this.abort.signal,
      );
      if (failure) throw failure;
      if (!summary.trim())
        throw new TurnError('The summary came back empty; the conversation was kept.');
      const before = this.input.length;
      this.input.length = 0;
      this.input.push({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Summary of our conversation so far (the full text was dropped to save space):\n\n${summary.trim()}`,
          },
        ],
      });
      this.push({ kind: 'thought', text: summary.trim() });
      this.push({
        kind: 'info',
        text: `Compacted ${before} conversation items into a summary (open "Thinking" above to read it).`,
      });
      this.setStatus('ready');
    } catch (e) {
      if (this.disposed) return;
      if (this.abort.signal.aborted)
        this.push({ kind: 'info', text: 'Stopped; the conversation was kept.' });
      else if ((e as { needsSignIn?: boolean }).needsSignIn)
        return this.needSignIn((e as Error).message);
      else this.push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      this.setStatus('ready');
    }
  }

  private pathOf(uri: string): string {
    const root = this.deps.files.root.replace(/\\/g, '/').replace(/\/+$/, '');
    const m = /^file:\/\/(.*?)(#L[\d-]+)?$/.exec(uri);
    if (!m) return uri;
    const abs = decodeURIComponent(m[1]!);
    const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
    return `${rel}${m[2] ? m[2].replace('#L', ':') : ''}`;
  }

  /** One model request; streams text into the transcript and returns the tool calls made. */
  private async request(
    signal: AbortSignal,
  ): Promise<Array<{ callId: string; name: string; args: string }>> {
    if (!this.currentModel) throw new TurnError('No model is available on this ChatGPT plan.');
    let message: Extract<TranscriptItem, { kind: 'agent' }> | undefined;
    let final: { status?: string; output?: Item[]; error?: unknown } | undefined;
    let failure: TurnError | undefined;
    await this.deps.host.responses(
      {
        model: this.currentModel,
        instructions: [INSTRUCTIONS, this.deps.guidance?.()].filter(Boolean).join('\n\n'),
        input: this.input,
        tools: TOOLS.filter((t) => this.currentMode !== 'read' || !WRITE_TOOLS.has(t.name)).map(
          (t) => ({ type: 'function', strict: false, ...t }),
        ),
        tool_choice: 'auto',
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
      },
      (event) => {
        const type = event.type as string;
        if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
          if (!message) {
            message = this.push({ kind: 'agent', text: '' }) as Extract<
              TranscriptItem,
              { kind: 'agent' }
            >;
          }
          message.text += event.delta;
          this.changed.fire();
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          final = event.response as typeof final;
        } else if (type === 'response.failed') {
          failure = providerError(0, { error: (event.response as { error?: unknown })?.error });
        } else if (type === 'error') {
          failure = providerError(0, event);
        } else if (type === 'http_error') {
          failure = providerError(Number(event.status) || 0, event.body);
        }
      },
      signal,
    );
    if (failure) throw failure;
    if (!final) throw new TurnError('The response ended before it finished. Try again.');
    const output = final.output ?? [];
    // Replay only what the API accepts back as input. Nothing is stored server-side, so item
    // ids would point at nothing: drop them (function calls keep their call_id; reasoning keeps
    // its encrypted content).
    for (const item of output) {
      if (item.type === 'reasoning' || item.type === 'message' || item.type === 'function_call') {
        const { status: _status, id: _id, ...rest } = item;
        this.input.push(rest);
      }
    }
    return output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        callId: String(item.call_id),
        name: String(item.name),
        args: String(item.arguments || '{}'),
      }));
  }

  // ---- tools ---------------------------------------------------------------------------------

  private askPermission(title: string): Promise<string | null> {
    const options: PermissionOption[] = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Allow for this chat', kind: 'allow_always' },
      { optionId: 'reject', name: 'Don’t allow', kind: 'reject_once' },
    ];
    return new Promise((resolve) => {
      let item: Extract<TranscriptItem, { kind: 'permission' }> | undefined;
      const respond = (optionId: string | null) => {
        if (!item || item.chosen) return;
        item.chosen = optionId ?? 'cancelled';
        this.changed.fire();
        resolve(optionId);
      };
      item = { kind: 'permission', id: nextItemId++, title, options, respond };
      this.items.push(item);
      this.changed.fire();
    });
  }

  private path(value: unknown): VaultPath {
    const p = String(value ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!p || p.split('/').some((part) => part === '..' || part === '.'))
      throw new Error('Give a path inside the vault, like "Folder/Note.md".');
    if (p === '.pumice' || p.startsWith('.pumice/'))
      throw new Error('That folder holds app settings.');
    return p;
  }

  private async runTool(call: { callId: string; name: string; args: string }): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.args) as Record<string, unknown>;
    } catch {
      return 'Error: the arguments were not valid JSON.';
    }
    const title =
      call.name === 'search_notes'
        ? `Search “${String(args.query ?? '')}”`
        : call.name === 'list_notes'
          ? `List ${args.folder ? String(args.folder) : 'notes'}`
          : `${{ read_note: 'Read', get_links: 'Links of', edit_note: 'Edit', create_note: 'Create' }[call.name] ?? call.name} ${String(args.path ?? '')}`;
    const abs = (p: string) => `${this.deps.files.root.replace(/\/+$/, '')}/${p}`;
    const tool = this.push({
      kind: 'tool',
      toolCallId: call.callId,
      title,
      toolKind: WRITE_TOOLS.has(call.name)
        ? 'edit'
        : call.name === 'search_notes'
          ? 'search'
          : 'read',
      status: 'in_progress',
      content: [],
      locations: typeof args.path === 'string' && args.path ? [abs(String(args.path))] : [],
    }) as Extract<TranscriptItem, { kind: 'tool' }>;
    const done = (status: string) => {
      tool.status = status;
      this.changed.fire();
    };
    try {
      const out = await this.execute(call.name, args, tool, abs);
      done('completed');
      return out;
    } catch (e) {
      done('failed');
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private async execute(
    name: string,
    args: Record<string, unknown>,
    tool: Extract<TranscriptItem, { kind: 'tool' }>,
    abs: (p: string) => string,
  ): Promise<string> {
    const { files, index, vault } = this.deps;
    switch (name) {
      case 'list_notes': {
        const folder = args.folder ? this.path(args.folder).replace(/\/+$/, '') : '';
        const paths = vault
          .files()
          .map((f) => f.path)
          .filter((p) => !folder || p.startsWith(`${folder}/`))
          .sort();
        if (!paths.length) return folder ? `No files under ${folder}.` : 'The vault is empty.';
        const shown = paths.slice(0, 500);
        return (
          shown.join('\n') +
          (paths.length > shown.length ? `\n… and ${paths.length - shown.length} more` : '')
        );
      }
      case 'search_notes': {
        const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30));
        const hits = await index.search(String(args.query ?? ''), { limit });
        if (!hits.length) return 'No matches.';
        return hits
          .map((h) => `${h.path}\n${h.snippets.map((s) => `  … ${s.text.trim()} …`).join('\n')}`)
          .join('\n\n');
      }
      case 'read_note': {
        const text = await files.read(this.path(args.path));
        return text.length > MAX_READ
          ? `${text.slice(0, MAX_READ)}\n\n[Truncated: the note has ${text.length} characters.]`
          : text || '(empty note)';
      }
      case 'get_links': {
        const path = this.path(args.path);
        if (!index.getFile(path)) throw new Error(`No such note: ${path}`);
        const out = [
          ...new Set(index.outgoing(path).map((l) => l.target ?? `${l.link.target} (missing)`)),
        ];
        const back = [...new Set(index.backlinks(path).map((l) => l.source))];
        return `Links to:\n${out.join('\n') || '(none)'}\n\nLinked from:\n${back.join('\n') || '(none)'}`;
      }
      case 'edit_note': {
        const path = this.path(args.path);
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        const text = await files.read(path);
        const first = oldText ? text.indexOf(oldText) : -1;
        if (first < 0)
          throw new Error(
            'old_text was not found in the note. Read the note and copy the text exactly.',
          );
        if (text.indexOf(oldText, first + 1) >= 0)
          throw new Error('old_text occurs more than once. Include more surrounding text.');
        const next = text.slice(0, first) + newText + text.slice(first + oldText.length);
        tool.content = [{ type: 'diff', path: abs(path), oldText: text, newText: next }];
        this.changed.fire();
        await this.allowWrite(name, `Edit ${path}`);
        await files.write(path, next);
        return `Edited ${path}.`;
      }
      case 'create_note': {
        const path = this.path(args.path);
        if (vault.get(path)) throw new Error(`${path} already exists. Use edit_note to change it.`);
        const content = String(args.content ?? '');
        tool.content = [{ type: 'diff', path: abs(path), oldText: '', newText: content }];
        this.changed.fire();
        await this.allowWrite(name, `Create ${path}`);
        await files.write(path, content);
        return `Created ${path}.`;
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  private async allowWrite(tool: string, title: string): Promise<void> {
    if (this.currentMode === 'read') throw new Error('The user set this chat to read only.');
    if (this.currentMode === 'auto' || this.alwaysAllowed.has(tool)) return;
    const answer = await this.askPermission(title);
    if (answer === 'always') this.alwaysAllowed.add(tool);
    else if (answer !== 'allow') throw new Error('The user did not allow this change.');
  }
}
