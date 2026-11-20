import { createHash, randomInt } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { encodeControl, type PublicUser, type Role } from '@pumice/collab-protocol';
import { WebSocketServer } from 'ws';
import { Store } from './db.ts';
import { SyncHub, type Connection } from './sync.ts';

export interface ServerOptions {
  dataDir: string;
  port?: number;
  host?: string;
  /** Return login codes in the API response (development and tests only). */
  devLogin?: boolean;
  /** Called with each login code; the default logs it (wire SMTP here). */
  sendLoginCode?: (email: string, code: string) => void | Promise<void>;
  /** Public base URL used in invite links. */
  publicUrl?: string;
  /** Maximum blob size in bytes. */
  maxBlobSize?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  store: Store;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
const isRole = (r: unknown): r is Role => r === 'owner' || r === 'editor' || r === 'viewer';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const raw = await body(req, 1_000_000);
  try {
    return (raw.length ? JSON.parse(raw.toString('utf8')) : {}) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const store = new Store(opts.dataDir);
  const hub = new SyncHub(store);
  const blobDir = join(opts.dataDir, 'blobs');
  const maxBlob = opts.maxBlobSize ?? 100 * 1024 * 1024;
  const sendCode =
    opts.sendLoginCode ??
    ((email, code) => console.log(`[pumice-server] login code for ${email}: ${code}`));

  const crashTimes = new Map<string, number[]>();
  const authUser = (req: IncomingMessage): PublicUser => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = token ? store.userForToken(token) : undefined;
    if (!user) throw new HttpError(401, 'Not signed in');
    return user;
  };
  const requireRole = (vault: string, user: PublicUser, min: Role): Role => {
    const role = store.role(vault, user.id);
    if (!role) throw new HttpError(404, 'No such vault');
    if (ROLE_RANK[role] < ROLE_RANK[min]) throw new HttpError(403, `Requires ${min} access`);
    return role;
  };

  const routes: Array<
    [
      string,
      RegExp,
      (req: IncomingMessage, res: ServerResponse, m: RegExpExecArray) => Promise<unknown>,
    ]
  > = [
    ['GET', /^\/api\/health$/, async () => ({ ok: true, version: 1 })],
    [
      'POST',
      /^\/api\/crash$/,
      async (req) => {
        // Opt-in crash reports from clients (no auth; small, rate-limited per address).
        const ip = req.socket.remoteAddress ?? '';
        const now = Date.now();
        const recent = (crashTimes.get(ip) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= 10) throw new HttpError(429, 'Too many reports');
        crashTimes.set(ip, [...recent, now]);
        const report = (await body(req, 20_000)).toString('utf8');
        try {
          JSON.parse(report);
        } catch {
          throw new HttpError(400, 'Invalid JSON');
        }
        store.addCrash(report);
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/api\/auth\/request$/,
      async (req) => {
        const { email } = await json<{ email?: string }>(req);
        const address = email?.trim().toLowerCase() ?? '';
        if (!EMAIL.test(address)) throw new HttpError(400, 'Enter a valid email address');
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        store.setLoginCode(address, code, 15 * 60 * 1000);
        await sendCode(address, code);
        return opts.devLogin ? { sent: true, code } : { sent: true };
      },
    ],
    [
      'POST',
      /^\/api\/auth\/verify$/,
      async (req) => {
        const { email, code, name, device } = await json<{
          email?: string;
          code?: string;
          name?: string;
          device?: string;
        }>(req);
        const address = email?.trim().toLowerCase() ?? '';
        if (!code || !store.consumeLoginCode(address, code.trim()))
          throw new HttpError(401, 'Wrong or expired code');
        const user =
          store.userByEmail(address) ??
          store.createUser(address, name?.trim() || address.split('@')[0]!);
        return { token: store.createSession(user.id, device ?? 'unknown'), user };
      },
    ],
    [
      'POST',
      /^\/api\/auth\/logout$/,
      async (req) => {
        const token = (req.headers.authorization ?? '').slice(7);
        store.deleteSession(token);
        return { ok: true };
      },
    ],
    [
      'GET',
      /^\/api\/me$/,
      async (req) => {
        const user = authUser(req);
        return { user, vaults: store.vaultsOf(user.id) };
      },
    ],
    [
      'POST',
      /^\/api\/vaults$/,
      async (req) => {
        const user = authUser(req);
        const { name } = await json<{ name?: string }>(req);
        if (!name?.trim()) throw new HttpError(400, 'A vault needs a name');
        return store.createVault(name.trim().slice(0, 200), user.id);
      },
    ],
    [
      'GET',
      /^\/api\/vaults\/([\w-]+)\/members$/,
      async (req, _res, m) => {
        requireRole(m[1]!, authUser(req), 'viewer');
        return store.members(m[1]!);
      },
    ],
    [
      'PATCH',
      /^\/api\/vaults\/([\w-]+)\/members\/([\w-]+)$/,
      async (req, _res, m) => {
        const user = authUser(req);
        requireRole(m[1]!, user, 'owner');
        const { role } = await json<{ role?: unknown }>(req);
        if (!isRole(role)) throw new HttpError(400, 'Invalid role');
        if (m[2] === user.id && role !== 'owner')
          throw new HttpError(400, 'Owners cannot demote themselves');
        store.setRole(m[1]!, m[2]!, role);
        return store.members(m[1]!);
      },
    ],
    [
      'DELETE',
      /^\/api\/vaults\/([\w-]+)\/members\/([\w-]+)$/,
      async (req, _res, m) => {
        const user = authUser(req);
        // Anyone may leave; owners may remove others.
        if (m[2] !== user.id) requireRole(m[1]!, user, 'owner');
        store.removeMember(m[1]!, m[2]!);
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/api\/vaults\/([\w-]+)\/invites$/,
      async (req, _res, m) => {
        const user = authUser(req);
        requireRole(m[1]!, user, 'owner');
        const { role = 'editor' } = await json<{ role?: unknown }>(req);
        if (!isRole(role) || role === 'owner')
          throw new HttpError(400, 'Invites are for editors or viewers');
        const invite = store.createInvite(m[1]!, role, user.id, 7 * 24 * 3600 * 1000);
        return { ...invite, role, url: `${opts.publicUrl ?? ''}/invite/${invite.token}` };
      },
    ],
    [
      'POST',
      /^\/api\/invites\/([\w-]+)\/accept$/,
      async (req, _res, m) => {
        const vault = store.acceptInvite(m[1]!, authUser(req).id);
        if (!vault) throw new HttpError(404, 'This invite is invalid or has expired');
        return vault;
      },
    ],
    [
      'PUT',
      /^\/api\/vaults\/([\w-]+)\/blobs\/([0-9a-f]{64})$/,
      async (req, _res, m) => {
        requireRole(m[1]!, authUser(req), 'editor');
        const data = await body(req, maxBlob);
        const hash = createHash('sha256').update(data).digest('hex');
        if (hash !== m[2]) throw new HttpError(400, 'Content does not match its hash');
        const dir = join(blobDir, m[1]!);
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.${hash}.tmp`);
        await writeFile(tmp, data);
        await rename(tmp, join(dir, hash));
        return { ok: true, size: data.length };
      },
    ],
    [
      'GET',
      /^\/api\/vaults\/([\w-]+)\/blobs\/([0-9a-f]{64})$/,
      async (req, res, m) => {
        requireRole(m[1]!, authUser(req), 'viewer');
        if (!SHA256.test(m[2]!)) throw new HttpError(400, 'Bad hash');
        let data: Buffer;
        try {
          data = await readFile(join(blobDir, m[1]!, m[2]!));
        } catch {
          throw new HttpError(404, 'No such blob');
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'private, max-age=31536000, immutable',
        });
        res.end(data);
        return undefined;
      },
    ],
    [
      'GET',
      /^\/api\/vaults\/([\w-]+)\/docs\/([^/]+)\/history$/,
      async (req, _res, m) => {
        requireRole(m[1]!, authUser(req), 'viewer');
        return store.snapshots(m[1]!, decodeURIComponent(m[2]!));
      },
    ],
    [
      'GET',
      /^\/api\/vaults\/([\w-]+)\/docs\/([^/]+)\/history\/(\d+)$/,
      async (req, res, m) => {
        requireRole(m[1]!, authUser(req), 'viewer');
        const data = store.snapshot(m[1]!, decodeURIComponent(m[2]!), Number(m[3]));
        if (!data) throw new HttpError(404, 'No such snapshot');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from(data));
        return undefined;
      },
    ],
  ];

  const http = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0]!;
    const route = routes.find(([method, re]) => method === req.method && re.test(path));
    if (!route) {
      res
        .writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    route[2](req, res, route[1].exec(path)!)
      .then((result) => {
        if (result !== undefined && !res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
        }
      })
      .catch((e: unknown) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error('[pumice-server]', e);
        if (!res.headersSent) {
          res
            .writeHead(status, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/sync') return socket.destroy();
    const token = url.searchParams.get('token') ?? '';
    const user = token ? store.userForToken(token) : undefined;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Connection = { socket: ws, user, awarenessIds: new Map() };
      ws.binaryType = 'nodebuffer';
      ws.send(
        encodeControl('', '', {
          type: 'hello',
          user,
          vaults: store.vaultsOf(user.id).map(({ id, name, role }) => ({ id, name, role })),
        }),
      );
      ws.on('message', (data: Buffer) => {
        // Roles are looked up per message, so revoked access takes effect immediately.
        hub.handleMessage(conn, new Uint8Array(data), (vault) => store.role(vault, user.id));
      });
      ws.on('close', () => hub.disconnect(conn));
      // Keep idle connections alive through proxies.
      const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 30_000);
      ws.on('close', () => clearInterval(ping));
    });
  });

  await new Promise<void>((resolve) =>
    http.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve),
  );
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);
  const url = `http://${opts.host ?? '127.0.0.1'}:${port}`;
  return {
    url,
    port,
    store,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      hub.close();
      store.close();
    },
  };
}
