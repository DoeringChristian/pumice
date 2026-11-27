/**
 * The agent chats of a served folder, kept by the server (docs/plan/11): the agents run here, in
 * the folder, whether or not a window is open; every window on the vault shows the same chats,
 * follows them as they go on, and prompts them in turn.
 *
 * The server is the agents' ACP client: their file requests read and change the vault's
 * documents here, as the agent (its own Yjs client and name), merged with what people type.
 * Chats are saved in the folder's `.pumice/chats/`, as the app saves them.
 */
import type { DocumentsApi, MetadataIndexApi, PlatformFs, VaultApi } from '@pumice/api';
import { textDrawings } from '@pumice/core-excalidraw/drawings';
import { ChatStore, chatTitle, storableItems, type SavedChat } from '@pumice/core-agents/chats';
import { Ledger, trackedFiles } from '@pumice/core-agents/ledger';
import {
  AgentSession,
  errorText,
  type AgentConfig,
  type TranscriptItem,
} from '@pumice/core-agents/session';
import {
  CHAT_ID,
  wireItem,
  type ClientMessage,
  type ServerMessage,
  type WireChat,
  type WireState,
} from '@pumice/core-agents/wire';
import { noteWriter } from '@pumice/core-agents/write';
import type { ProcessHost } from '@pumice/platform';
import type { WebSocket } from 'ws';

/** The colour an assistant's changes are shown in (as in the app). */
const AGENT_COLOR = '#8b5cf6';
/** Chats kept open over a restart of the server. */
const OPEN_FILE = '.pumice/chats/open.json';

interface Person {
  id: string;
  name: string;
}

interface Prompt {
  req: number;
  text: string;
  blocks: Extract<ClientMessage, { t: 'prompt' }>['blocks'];
  label?: string;
  by: Person;
  client: Client;
}

interface Chat {
  id: string;
  agent: AgentConfig;
  name?: string;
  title: string;
  created: string;
  updated: string;
  by?: Person;
  forkedFrom?: string;
  /** What the windows' plugins tell agents about the app (the last window to say: wire.ts). */
  guidance?: string;
  /** Among the open chats (of every window). */
  open: boolean;
  /** Its agent, while it runs (or until it stopped). */
  session?: AgentSession;
  /** Its agent being started (one start at a time), and for which of its lives (`ends`). */
  starting?: Promise<void>;
  startingFor?: number;
  /** Counts its ends: a start that an end overtook stops there. */
  ends: number;
  /** "Allow everything" as set while its agent was not there. */
  autoApprove?: boolean;
  sub?: { dispose(): void };
  /** What was said, while its agent does not run (from its file). */
  saved?: SavedChat;
  queue: Prompt[];
  current?: Prompt;
  followers: Set<Client>;
  /** What followers were sent last, by item id (JSON), and the state. */
  sent: Map<number, string>;
  sentState?: string;
  updateTimer?: ReturnType<typeof setTimeout>;
  saveTimer?: ReturnType<typeof setTimeout>;
}

interface Client {
  socket: WebSocket;
  user: Person;
  /** The list it was sent last (JSON). */
  list?: string;
}

export class AgentChats {
  private readonly chats = new Map<string, Chat>();
  private readonly clients = new Set<Client>();
  private readonly store: ChatStore;
  private readonly ledger: Ledger;
  private readonly writer: ReturnType<typeof noteWriter>;
  private readonly loaded: Promise<void>;
  private readonly saving = new Set<Promise<void>>();

  constructor(
    private readonly opts: {
      /** The folder (its real path): agents run in it and speak of its files by it. */
      root: string;
      fs: PlatformFs;
      vault: VaultApi;
      documents: DocumentsApi;
      /** Search and links, for the assistants' tools (vault-tools.ts). */
      index?: MetadataIndexApi;
      agents: AgentConfig[];
      processes: ProcessHost;
    },
  ) {
    this.store = new ChatStore(opts.fs);
    this.ledger = new Ledger(opts.fs);
    this.writer = noteWriter(opts.documents, opts.vault);
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    await this.ledger.load();
    let open: string[] = [];
    try {
      if (await this.opts.fs.stat(OPEN_FILE)) {
        const kept: unknown = JSON.parse(await this.opts.fs.readText(OPEN_FILE));
        if (Array.isArray(kept)) open = kept.filter((id): id is string => typeof id === 'string');
      }
    } catch {
      // (None kept open.)
    }
    for (const c of await this.store.list()) {
      const agent = this.opts.agents.find((a) => a.id === c.agent);
      if (!agent) continue;
      this.chats.set(c.id, {
        id: c.id,
        agent,
        ...(c.name ? { name: c.name } : {}),
        title: c.title,
        created: c.created,
        updated: c.updated,
        ...(c.by ? { by: c.by } : {}),
        // Its agent starts again with the next prompt.
        open: open.includes(c.id),
        ends: 0,
        queue: [],
        followers: new Set(),
        sent: new Map(),
      });
    }
  }

  /** Who sees a chat. (Every chat is the vault's for now; see docs/plan/11, private chats.) */
  private visibleTo(_chat: Chat, _user: Person): boolean {
    return true;
  }

  // ---- connections ---------------------------------------------------------------------------

  /** A window on the vault (`user` is in it, as an owner). */
  async connect(socket: WebSocket, user: Person): Promise<void> {
    const client: Client = { socket, user };
    // What arrives while the chats are read is kept for after.
    const early: string[] = [];
    const keep = (data: unknown) => early.push(String(data));
    socket.on('message', keep);
    await this.loaded;
    if (socket.readyState !== socket.OPEN) return;
    this.clients.add(client);
    socket.on('close', () => {
      this.clients.delete(client);
      for (const chat of this.chats.values()) chat.followers.delete(client);
    });
    this.send(client, {
      t: 'hello',
      agents: this.opts.agents.map(({ id, name, setupHint }) => ({
        id,
        name,
        ...(setupHint ? { setupHint } : {}),
      })),
      root: this.opts.root,
      user,
    });
    this.listChanged();
    const handle = (data: unknown) => {
      let m: ClientMessage;
      try {
        m = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      void this.handle(client, m).catch((e: unknown) =>
        this.send(client, { t: 'error', message: errorText(e) }),
      );
    };
    socket.off('message', keep);
    for (const m of early.splice(0)) handle(m);
    socket.on('message', handle);
  }

  private send(client: Client, m: ServerMessage): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(m));
  }

  private chat(client: Client, id: string): Chat {
    const chat = typeof id === 'string' ? this.chats.get(id) : undefined;
    if (!chat || !this.visibleTo(chat, client.user)) throw new Error('No such chat.');
    return chat;
  }

  private async handle(client: Client, m: ClientMessage): Promise<void> {
    switch (m.t) {
      case 'new':
        return this.create(client, m);
      case 'open': {
        const chat = this.chat(client, m.id);
        this.guide(chat, m.guidance);
        this.setOpen(chat, true);
        await this.run(chat);
        return;
      }
      case 'follow': {
        const chat = this.chat(client, m.id);
        this.guide(chat, m.guidance);
        chat.followers.add(client);
        await this.ensureItems(chat);
        this.send(client, {
          t: 'chat',
          id: chat.id,
          items: this.items(chat).map(wireItem),
          state: this.state(chat),
        });
        return;
      }
      case 'unfollow':
        this.chats.get(m.id)?.followers.delete(client);
        return;
      case 'prompt': {
        const chat = this.chat(client, m.id);
        if (typeof m.text !== 'string' || !Number.isInteger(m.req)) return;
        this.setOpen(chat, true);
        chat.queue.push({
          req: m.req,
          text: m.text,
          blocks: Array.isArray(m.blocks) ? m.blocks : [],
          ...(typeof m.label === 'string' ? { label: m.label } : {}),
          by: client.user,
          client,
        });
        this.listChanged();
        await this.flush(chat);
        return;
      }
      case 'cancel':
        this.chat(client, m.id).session?.cancel();
        return;
      case 'answer': {
        const item = this.chat(client, m.id).session?.items.find((i) => i.id === m.item);
        // The first answer counts.
        if (item?.kind === 'permission' && !item.chosen) item.respond?.(m.option ?? null);
        return;
      }
      case 'mode':
        await this.chat(client, m.id).session?.setMode(String(m.mode));
        return;
      case 'model':
        await this.chat(client, m.id).session?.setModel(String(m.model));
        return;
      case 'effort':
        await this.chat(client, m.id).session?.setEffort(String(m.effort));
        return;
      case 'auth':
        await this.chat(client, m.id).session?.authenticate(String(m.method));
        return;
      case 'auto': {
        const chat = this.chat(client, m.id);
        // (Kept with the chat too: its agent may not be there yet.)
        chat.autoApprove = !!m.on;
        if (chat.session) chat.session.setAutoApprove(!!m.on);
        else if (chat.saved) chat.saved.autoApprove = !!m.on;
        this.changed(chat);
        return;
      }
      case 'rename': {
        const chat = this.chat(client, m.id);
        const name = String(m.name ?? '').trim();
        if (name) chat.name = name;
        else delete chat.name;
        this.save(chat, true);
        this.listChanged();
        return;
      }
      case 'end':
        return this.end(this.chat(client, m.id));
      case 'delete': {
        const chat = this.chat(client, m.id);
        await this.end(chat);
        this.chats.delete(chat.id);
        await this.store.remove(chat.id);
        this.listChanged();
        return;
      }
    }
  }

  // ---- chats ---------------------------------------------------------------------------------

  private async create(client: Client, m: Extract<ClientMessage, { t: 'new' }>): Promise<void> {
    if (!CHAT_ID.test(String(m.id)) || this.chats.has(m.id)) throw new Error('Not a new chat.');
    const agent = this.opts.agents.find((a) => a.id === m.agent);
    if (!agent) throw new Error('This agent does not run here.');
    const now = new Date().toISOString();
    const chat: Chat = {
      id: m.id,
      agent,
      ...(m.name?.trim() ? { name: m.name.trim() } : {}),
      title: 'New chat',
      created: now,
      updated: now,
      by: client.user,
      open: true,
      ends: 0,
      queue: [],
      followers: new Set([client]),
      sent: new Map(),
    };
    this.guide(chat, m.guidance);
    if (m.fork) {
      // It starts with what was said in that one; its agent is told, with the first message.
      const from = this.chat(client, m.fork);
      await this.ensureItems(from);
      chat.forkedFrom = from.id;
      chat.saved = {
        version: 1,
        id: chat.id,
        agent: agent.id,
        title: chat.name ?? `${from.name ?? from.title} (fork)`,
        created: now,
        updated: now,
        forkedFrom: from.id,
        items: JSON.parse(JSON.stringify(storableItems(this.items(from)))) as TranscriptItem[],
      };
    }
    this.chats.set(chat.id, chat);
    void this.keepOpen();
    this.listChanged();
    await this.run(chat);
    if (m.fork) this.save(chat, true);
  }

  private guide(chat: Chat, guidance: unknown): void {
    if (typeof guidance === 'string' && guidance.trim()) chat.guidance = guidance.slice(0, 50_000);
  }

  /** The chat's transcript is at hand (read from its file if its agent does not run). */
  private async ensureItems(chat: Chat): Promise<void> {
    if (chat.session || chat.saved) return;
    chat.saved = await this.store.load(chat.id);
  }

  private items(chat: Chat): TranscriptItem[] {
    return chat.session?.items ?? chat.saved?.items ?? [];
  }

  /**
   * Starts the chat's agent (again: on its saved conversation) if it does not run. One start at a
   * time: whoever asks meanwhile waits for that one.
   */
  private run(chat: Chat): Promise<void> {
    if (chat.starting && chat.startingFor === chat.ends) return chat.starting;
    // A start the chat's end overtook stops by itself: a new one follows it.
    const before = chat.starting ?? Promise.resolve();
    const starting: Promise<void> = before
      .catch(() => undefined)
      .then(() => this.start(chat))
      .finally(() => {
        if (chat.starting === starting) chat.starting = undefined;
      });
    chat.starting = starting;
    chat.startingFor = chat.ends;
    return starting;
  }

  private async start(chat: Chat): Promise<void> {
    const s = chat.session;
    // (Waiting for a sign-in: it goes on from there.)
    if (s && s.status !== 'closed' && !(s.status === 'error' && !s.loginOptions.length)) return;
    const ends = chat.ends;
    await this.ensureItems(chat);
    // Ended meanwhile: no agent for it.
    if (chat.ends !== ends) return;
    // From what is said now (an agent that stopped), or from its file.
    const saved: SavedChat | undefined = s
      ? {
          version: 1,
          id: chat.id,
          agent: chat.agent.id,
          title: chat.title,
          created: chat.created,
          updated: chat.updated,
          ...s.snapshot(),
          items: storableItems(s.items),
        }
      : chat.saved;
    if (s) {
      chat.sub?.dispose();
      s.dispose();
    }
    const files = trackedFiles(
      this.writer.filesAs(this.opts.root, {
        kind: 'agent',
        name: chat.agent.name.replace(/\s*\(.*\)$/, ''),
        color: AGENT_COLOR,
      }),
      this.ledger,
      () => ({ id: chat.id, name: chat.name ?? chat.title }),
    );
    const session = new AgentSession(
      chat.agent,
      this.opts.processes,
      files,
      () => chat.guidance ?? '',
      saved?.items.length || saved?.sessionId ? { ...saved, id: chat.id } : undefined,
      chat.id,
      () => this.vaultContext(),
    );
    if (chat.autoApprove !== undefined) session.setAutoApprove(chat.autoApprove);
    chat.session = session;
    chat.saved = undefined;
    chat.sub = session.onDidChange(() => this.changed(chat));
    // Its items have new ids: followers get it whole.
    chat.sent.clear();
    chat.sentState = undefined;
    for (const f of chat.followers)
      this.send(f, {
        t: 'chat',
        id: chat.id,
        items: session.items.map(wireItem),
        state: this.state(chat),
      });
    // (Ended while it starts: `end` disposes it, and with it the program, once it is there.)
    await session.start();
    if (chat.ends === ends) this.changed(chat);
  }

  private async end(chat: Chat): Promise<void> {
    chat.ends++;
    for (const p of chat.queue.splice(0))
      this.send(p.client, { t: 'done', req: p.req, error: 'The chat was closed.' });
    if (chat.session) {
      this.save(chat, true);
      chat.saved = {
        version: 1,
        id: chat.id,
        agent: chat.agent.id,
        title: chat.title,
        created: chat.created,
        updated: chat.updated,
        ...chat.session.snapshot(),
        items: storableItems(chat.session.items),
      };
      chat.sub?.dispose();
      chat.session.dispose();
      chat.session = undefined;
      chat.sent.clear();
      chat.sentState = undefined;
    }
    this.setOpen(chat, false);
    // A chat nothing was said in is not kept.
    if (!this.items(chat).some((i) => i.kind === 'user')) this.chats.delete(chat.id);
    this.listChanged();
  }

  /** Hands the next prompt to the agent once it can take it. */
  private async flush(chat: Chat): Promise<void> {
    if (chat.current || !chat.queue.length) return;
    await this.run(chat);
    const s = chat.session;
    if (s?.status !== 'ready' || chat.current) return;
    const next = chat.queue.shift()!;
    chat.current = next;
    this.listChanged();
    s.prompt(next.text, next.blocks, next.label, next.by.name)
      .then(
        () => this.send(next.client, { t: 'done', req: next.req }),
        (e: unknown) => this.send(next.client, { t: 'done', req: next.req, error: errorText(e) }),
      )
      .finally(() => {
        chat.current = undefined;
        void this.flush(chat);
      });
  }

  private setOpen(chat: Chat, open: boolean): void {
    if (chat.open === open) return;
    chat.open = open;
    this.keepOpen();
    this.listChanged();
  }

  /** Writes which chats are open, for after a restart. */
  private keepOpen(): Promise<void> {
    // One write at a time, of the list as it is when it is written: never an older one last.
    if (this.openQueued) return this.openWrites;
    this.openQueued = true;
    const writing = this.openWrites
      .then(async () => {
        this.openQueued = false;
        const ids = [...this.chats.values()].filter((c) => c.open).map((c) => c.id);
        await this.opts.fs.write(OPEN_FILE, `${JSON.stringify(ids)}\n`);
      })
      .catch((e: unknown) => console.error('[pumice-server] could not keep the open chats', e))
      .finally(() => this.saving.delete(writing));
    this.openWrites = writing;
    this.saving.add(writing);
    return writing;
  }
  private openWrites: Promise<void> = Promise.resolve();
  private openQueued = false;

  /** Its agent did something: followers hear it, the list too, the file is written soon. */
  private changed(chat: Chat): void {
    const s = chat.session;
    if (s && s.status === 'ready') void this.flush(chat);
    if (s?.items.some((i) => i.kind === 'user')) {
      chat.title = chat.name ?? chatTitle(s.items);
      this.save(chat);
    }
    this.listChanged();
    if (chat.updateTimer) return;
    chat.updateTimer = setTimeout(() => {
      chat.updateTimer = undefined;
      this.sendUpdate(chat);
    }, 40);
  }

  private sendUpdate(chat: Chat): void {
    if (!chat.followers.size) return;
    const items = [];
    for (const item of this.items(chat)) {
      const wire = wireItem(item);
      const json = JSON.stringify(wire);
      if (chat.sent.get(item.id) === json) continue;
      chat.sent.set(item.id, json);
      items.push(wire);
    }
    const state = this.state(chat);
    const stateJson = JSON.stringify(state);
    const stateChanged = stateJson !== chat.sentState;
    chat.sentState = stateJson;
    if (!items.length && !stateChanged) return;
    for (const f of chat.followers)
      this.send(f, { t: 'update', id: chat.id, items, ...(stateChanged ? { state } : {}) });
  }

  private state(chat: Chat): WireState {
    const s = chat.session;
    if (!s)
      return {
        // (Its agent starts with the next prompt.)
        status: 'ready',
        modes: [],
        models: [],
        efforts: [],
        commands: [],
        loginOptions: [],
        autoApprove: !!chat.saved?.autoApprove,
      };
    return {
      // An agent that stopped starts again with the next prompt.
      status: s.status === 'closed' ? 'ready' : s.status,
      modes: s.modes,
      ...(s.currentMode ? { currentMode: s.currentMode } : {}),
      models: s.models,
      ...(s.currentModel ? { currentModel: s.currentModel } : {}),
      efforts: s.efforts,
      ...(s.currentEffort ? { currentEffort: s.currentEffort } : {}),
      commands: s.commands,
      loginOptions: s.status === 'error' ? s.loginOptions : [],
      autoApprove: s.autoApprove,
    };
  }

  private save(chat: Chat, now = false): void {
    clearTimeout(chat.saveTimer);
    const write = () => {
      chat.saveTimer = undefined;
      const snapshot = chat.session?.snapshot() ?? chat.saved;
      if (!snapshot) return;
      chat.updated = new Date().toISOString();
      const saving = this.store
        .save(chat.id, chat.agent.id, snapshot, chat.name, {
          ...(chat.by ? { by: chat.by } : {}),
          ...(chat.forkedFrom && !snapshot.sessionId ? { forkedFrom: chat.forkedFrom } : {}),
        })
        .catch((e: unknown) => console.error('[pumice-server] could not save a chat', e))
        .finally(() => this.saving.delete(saving));
      this.saving.add(saving);
    };
    if (now) write();
    else chat.saveTimer = setTimeout(write, 1000);
  }

  private listFor(user: Person): WireChat[] {
    return [...this.chats.values()]
      .filter((c) => this.visibleTo(c, user))
      .map((c) => ({
        id: c.id,
        agent: c.agent.id,
        title: c.name ?? c.title,
        ...(c.name ? { name: c.name } : {}),
        created: c.created,
        updated: c.updated,
        ...(c.by ? { by: c.by } : {}),
        open: c.open,
        status: this.state(c).status,
        waiting: this.items(c).some((i) => i.kind === 'permission' && !i.chosen),
        queued: c.queue.length + (c.current ? 1 : 0),
      }))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  private listChanged(): void {
    for (const client of this.clients) {
      const chats = this.listFor(client.user);
      const json = JSON.stringify(chats);
      if (json === client.list) continue;
      client.list = json;
      this.send(client, { t: 'chats', chats });
    }
  }

  /** What the vault's tools work with here (vault-tools.ts). */
  private vaultContext() {
    return {
      vault: this.opts.vault,
      ...(this.opts.index ? { index: this.opts.index } : {}),
      // (Read and changed as text; no pictures of them here.)
      drawings: this.drawings,
    };
  }

  private readonly drawings = textDrawings();

  /** Writes what is pending and ends the agents (the server stops). */
  async close(): Promise<void> {
    for (const chat of this.chats.values()) {
      clearTimeout(chat.updateTimer);
      if (chat.saveTimer || chat.session) this.save(chat, true);
      chat.sub?.dispose();
      chat.session?.dispose();
      chat.session = undefined;
    }
    await Promise.all([...this.saving]);
    await this.ledger.flush();
    for (const c of this.clients) c.socket.close();
  }
}
