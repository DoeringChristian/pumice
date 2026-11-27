import type { ContentBlock } from '@agentclientprotocol/sdk';
import { Emitter, type SharedVaultSession } from '@pumice/api';
import { newChatId, type ChatSnapshot, type ChatSummary } from './chats';
import type {
  AgentConfig,
  ChatSession,
  SessionStatus,
  SlashCommand,
  TranscriptItem,
} from './session';
import type { ClientMessage, ServerMessage, WireChat, WireItem, WireState } from './wire';

/**
 * The agent chats a served folder's server keeps (docs/plan/11), as this window sees them: the
 * list, and the chats it follows. One WebSocket, `/agents`, kept open (and opened again).
 */
export class ServerChats {
  /** The agents that run on the server. */
  agents: AgentConfig[] = [];
  /** Every chat of the vault, most recent first. */
  chats: WireChat[] = [];
  private socket: WebSocket | undefined;
  private readonly outbox: ClientMessage[] = [];
  private readonly followed = new Map<string, RemoteSession>();
  private readonly turns = new Map<number, { done(): void; failed(e: Error): void }>();
  private nextReq = 1;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly changed = new Emitter<void>();
  /** The list or the agents changed. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly shared: SharedVaultSession) {
    this.connect();
  }

  private connect(): void {
    const { server, vaultId, token } = this.shared;
    const url = `${server.replace(/^http/, 'ws')}/agents?vault=${encodeURIComponent(vaultId)}&token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      // Following again what this window shows, then what waited to be sent.
      for (const id of this.followed.keys()) socket.send(JSON.stringify({ t: 'follow', id }));
      for (const m of this.outbox.splice(0)) socket.send(JSON.stringify(m));
    };
    socket.onmessage = (e) => {
      try {
        this.receive(JSON.parse(String(e.data)) as ServerMessage);
      } catch (err) {
        console.error('[pumice] agent chats:', err);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      // A turn's end is not heard over a lost connection: what waits for one goes on.
      for (const turn of this.turns.values()) turn.done();
      this.turns.clear();
      if (this.disposed) return;
      this.timer = setTimeout(() => this.connect(), Math.min(30_000, 500 * 2 ** this.retry++));
    };
  }

  send(m: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(m));
    else this.outbox.push(m);
  }

  private receive(m: ServerMessage): void {
    switch (m.t) {
      case 'hello':
        this.agents = m.agents.map((a) => ({
          ...a,
          name: `${a.name} (on the server)`,
          command: '',
          args: [],
          server: true,
        }));
        this.changed.fire();
        return;
      case 'chats':
        this.chats = m.chats;
        this.changed.fire();
        return;
      case 'chat':
        this.followed.get(m.id)?.reset(m.items, m.state);
        return;
      case 'update':
        this.followed.get(m.id)?.update(m.items, m.state);
        return;
      case 'done': {
        const turn = this.turns.get(m.req);
        this.turns.delete(m.req);
        if (m.error) turn?.failed(new Error(m.error));
        else turn?.done();
        return;
      }
      case 'error':
        console.warn('[pumice] agent chats:', m.message);
        return;
    }
  }

  find(id: string): WireChat | undefined {
    return this.chats.find((c) => c.id === id);
  }

  /** The server's chats as the list of earlier chats has them. */
  summaries(): ChatSummary[] {
    return this.chats.map((c) => ({
      id: c.id,
      agent: c.agent,
      title: c.title,
      ...(c.name ? { name: c.name } : {}),
      created: c.created,
      updated: c.updated,
      ...(c.by ? { by: c.by } : {}),
    }));
  }

  follow(session: RemoteSession): void {
    this.followed.set(session.chatId, session);
  }

  unfollow(id: string): void {
    if (this.followed.delete(id)) this.send({ t: 'unfollow', id });
  }

  /** Sends a prompt; resolves when its turn is over. */
  prompt(id: string, text: string, blocks: ContentBlock[], label?: string): Promise<void> {
    const req = this.nextReq++;
    return new Promise((done, failed) => {
      this.turns.set(req, { done, failed });
      this.send({ t: 'prompt', id, req, text, blocks, ...(label ? { label } : {}) });
    });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.changed.dispose();
  }
}

/** How a window comes to a server's chat. */
export type Joining =
  | { kind: 'new'; fork?: string; name?: string }
  /** An earlier chat: its agent starts again. */
  | { kind: 'open' }
  /** A chat open already (in another window, or kept open by the server). */
  | { kind: 'follow' };

/** A chat the server keeps, as the panel sees chats. */
export class RemoteSession implements ChatSession {
  items: TranscriptItem[] = [];
  status: SessionStatus = 'starting';
  modes: Array<{ id: string; name: string }> = [];
  currentMode: string | undefined;
  models: Array<{ id: string; name: string }> = [];
  currentModel: string | undefined;
  efforts: Array<{ id: string; name: string }> = [];
  currentEffort: string | undefined;
  commands: SlashCommand[] = [];
  loginOptions: Array<{ id: string; name: string }> = [];
  autoApprove = false;
  /** It was seen among the server's open chats (from then on, that list says whether it is). */
  confirmed = false;
  readonly chatId: string;
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly server: ServerChats,
    readonly config: AgentConfig,
    private readonly joining: Joining,
    chatId?: string,
    /** What this window's plugins tell agents about the app (see wire.ts). */
    private readonly guidance: () => string = () => '',
  ) {
    this.chatId = chatId ?? newChatId();
  }

  snapshot(): ChatSnapshot {
    return { items: this.items };
  }

  async start(): Promise<void> {
    this.server.follow(this);
    const id = this.chatId;
    const j = this.joining;
    const guidance = this.guidance();
    if (j.kind === 'new')
      this.server.send({
        t: 'new',
        id,
        agent: this.config.id,
        ...(j.fork ? { fork: j.fork } : {}),
        ...(j.name ? { name: j.name } : {}),
        guidance,
      });
    else {
      if (j.kind === 'open') this.server.send({ t: 'open', id, guidance });
      this.server.send({ t: 'follow', id, guidance });
    }
  }

  /** The chat, whole. */
  reset(items: WireItem[], state: WireState): void {
    this.items = items.map((i) => this.live(i));
    this.setState(state);
    this.changed.fire();
  }

  /** Items new or changed, and the state if it changed. */
  update(items: WireItem[], state?: WireState): void {
    for (const wire of items) {
      const item = this.live(wire);
      const at = this.items.findIndex((i) => i.id === item.id);
      if (at >= 0) this.items[at] = item;
      else this.items.push(item);
    }
    if (state) this.setState(state);
    this.changed.fire();
  }

  private live(item: WireItem): TranscriptItem {
    if (item.kind !== 'permission' || item.chosen) return item as TranscriptItem;
    // Answered on the server; the first answer (from any window) counts.
    return {
      ...item,
      respond: (option: string | null) =>
        this.server.send({ t: 'answer', id: this.chatId, item: item.id, option }),
    };
  }

  private setState(s: WireState): void {
    this.status = s.status;
    this.modes = s.modes;
    this.currentMode = s.currentMode;
    this.models = s.models;
    this.currentModel = s.currentModel;
    this.efforts = s.efforts ?? [];
    this.currentEffort = s.currentEffort;
    this.commands = s.commands;
    this.loginOptions = s.loginOptions;
    this.autoApprove = s.autoApprove;
  }

  authenticate(methodId: string): Promise<void> {
    this.server.send({ t: 'auth', id: this.chatId, method: methodId });
    return Promise.resolve();
  }

  setMode(modeId: string): Promise<void> {
    this.server.send({ t: 'mode', id: this.chatId, mode: modeId });
    return Promise.resolve();
  }

  setModel(modelId: string): Promise<void> {
    this.server.send({ t: 'model', id: this.chatId, model: modelId });
    return Promise.resolve();
  }

  setEffort(effortId: string): Promise<void> {
    this.server.send({ t: 'effort', id: this.chatId, effort: effortId });
    return Promise.resolve();
  }

  setAutoApprove(on: boolean): void {
    this.server.send({ t: 'auto', id: this.chatId, on });
  }

  prompt(text: string, context: ContentBlock[] = [], contextLabel?: string): Promise<void> {
    // Busy from now on (the server says so too, soon): one message at a time from here.
    this.status = 'working';
    this.changed.fire();
    return this.server.prompt(this.chatId, text, context, contextLabel);
  }

  cancel(): void {
    this.server.send({ t: 'cancel', id: this.chatId });
  }

  rename(name: string): void {
    this.server.send({ t: 'rename', id: this.chatId, name });
  }

  /** Ends its agent on the server (for every window); the chat stays among the earlier ones. */
  end(): void {
    this.server.send({ t: 'end', id: this.chatId });
  }

  /** This window stops following it; it goes on on the server. */
  dispose(): void {
    this.server.unfollow(this.chatId);
    this.changed.dispose();
  }
}
