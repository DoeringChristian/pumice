import {
  MessageKind,
  decodeControl,
  decodeEnvelope,
  encodeEnvelope,
  type ControlMessage,
  type Envelope,
  type Invite,
  type Member,
  type PublicUser,
  type Role,
  type SnapshotInfo,
  type VaultInfo,
} from '@pumice/collab-protocol';
import { Emitter } from '@pumice/api';

export type ConnectionState = 'offline' | 'connecting' | 'online';

/** REST + WebSocket client for one server and account. */
export class CollabClient {
  private socket: WebSocket | undefined;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = true;
  private readonly stateChanged = new Emitter<ConnectionState>();
  readonly onDidChangeState = this.stateChanged.event;
  private readonly messages = new Emitter<Envelope>();
  /** Sync and awareness messages from the server. */
  readonly onMessage = this.messages.event;
  private readonly controls = new Emitter<{
    vault: string;
    doc: string;
    message: ControlMessage;
  }>();
  readonly onControl = this.controls.event;
  private readonly opened = new Emitter<void>();
  /** Fires on every (re)connect: resend sync step 1 for all documents. */
  readonly onOpen = this.opened.event;
  state: ConnectionState = 'offline';

  constructor(
    readonly server: string,
    private token: string | undefined,
  ) {}

  get signedIn(): boolean {
    return !!this.token;
  }

  private async api<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    const res = await fetch(`${this.server.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined && !(body instanceof Uint8Array)
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      ...(body !== undefined
        ? { body: body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body) }
        : {}),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `${res.status} ${res.statusText}`);
    }
    return (raw ? new Uint8Array(await res.arrayBuffer()) : await res.json()) as T;
  }

  /** `where: 'log'`: the code is printed where the server runs, not sent. */
  requestCode(email: string): Promise<{ sent: boolean; code?: string; where?: 'log' }> {
    return this.api('POST', '/api/auth/request', { email });
  }

  async verify(
    email: string,
    code: string,
    name?: string,
    device?: string,
  ): Promise<{ token: string; user: PublicUser }> {
    const result = await this.api<{ token: string; user: PublicUser }>('POST', '/api/auth/verify', {
      email,
      code,
      name,
      device,
    });
    this.token = result.token;
    return result;
  }

  me(): Promise<{ user: PublicUser; vaults: VaultInfo[] }> {
    return this.api('GET', '/api/me');
  }

  createVault(name: string): Promise<VaultInfo> {
    return this.api('POST', '/api/vaults', { name });
  }

  members(vault: string): Promise<Member[]> {
    return this.api('GET', `/api/vaults/${vault}/members`);
  }

  setRole(vault: string, userId: string, role: Role): Promise<Member[]> {
    return this.api('PATCH', `/api/vaults/${vault}/members/${userId}`, { role });
  }

  removeMember(vault: string, userId: string): Promise<unknown> {
    return this.api('DELETE', `/api/vaults/${vault}/members/${userId}`);
  }

  invite(vault: string, role: Role): Promise<Invite & { url: string }> {
    return this.api('POST', `/api/vaults/${vault}/invites`, { role });
  }

  acceptInvite(token: string): Promise<VaultInfo> {
    return this.api('POST', `/api/invites/${encodeURIComponent(token)}/accept`);
  }

  uploadBlob(vault: string, hash: string, data: Uint8Array): Promise<unknown> {
    return this.api('PUT', `/api/vaults/${vault}/blobs/${hash}`, data);
  }

  downloadBlob(vault: string, hash: string): Promise<Uint8Array> {
    return this.api('GET', `/api/vaults/${vault}/blobs/${hash}`, undefined, true);
  }

  history(vault: string, doc: string): Promise<SnapshotInfo[]> {
    return this.api('GET', `/api/vaults/${vault}/docs/${encodeURIComponent(doc)}/history`);
  }

  snapshot(vault: string, doc: string, id: number): Promise<Uint8Array> {
    return this.api(
      'GET',
      `/api/vaults/${vault}/docs/${encodeURIComponent(doc)}/history/${id}`,
      undefined,
      true,
    );
  }

  // ---- WebSocket ---------------------------------------------------------------------------------

  connect(): void {
    if (!this.token) return;
    this.closed = false;
    if (this.socket) return;
    this.setState('connecting');
    const url = `${this.server.replace(/^http/, 'ws').replace(/\/$/, '')}/sync?token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.setState('online');
      this.opened.fire();
    };
    socket.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      let env: Envelope;
      try {
        env = decodeEnvelope(new Uint8Array(e.data));
      } catch (err) {
        console.warn('[core.collab] bad message', err);
        return;
      }
      if (env.kind === MessageKind.Control)
        this.controls.fire({ vault: env.vault, doc: env.doc, message: decodeControl(env.payload) });
      else this.messages.fire(env);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.setState('offline');
      if (this.closed) return;
      // Exponential backoff up to 30 s, with jitter.
      const delay = Math.min(30_000, 500 * 2 ** this.retry++) * (0.75 + Math.random() / 2);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    socket.onerror = () => socket.close();
  }

  disconnect(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.setState('offline');
  }

  send(kind: MessageKind, vault: string, doc: string, payload: Uint8Array): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(encodeEnvelope({ kind, vault, doc, payload }));
    return true;
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.stateChanged.fire(state);
  }

  dispose(): void {
    this.disconnect();
    this.stateChanged.dispose();
    this.messages.dispose();
    this.controls.dispose();
    this.opened.dispose();
  }
}
