import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { encodeControl, type PublicUser, type Role } from '@pumice/collab-protocol';
import { WebSocketServer } from 'ws';
import type { AgentChats } from './sessions.ts';
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
  /**
   * Vaults open with their links (served folders, see OpenVault): no accounts, so no signing
   * in, no vaults made or invites given through the server.
   */
  open?: boolean;
  /** The built web app (apps/web/dist): served to browsers, which then use this server. */
  webApp?: string;
}

/**
 * A vault that opens with its link (a served folder): whoever has it gets in, each browser or
 * device under a name of its own (no accounts), and may also run agents in the folder.
 */
export interface OpenVault {
  vaultId: string;
  name: string;
  /** The key in its link. */
  key: string;
  /** The folder on disk: agents run in it (and speak of its files by their path in it). */
  root: string;
  /** Its agent chats (see sessions.ts), with the agents that may run in it. */
  chats?: AgentChats;
  agents: string[];
}

export interface RunningServer {
  url: string;
  port: number;
  store: Store;
  /** Serves this vault by its links (see OpenVault); the server has to be `open`. */
  addOpenVault(vault: OpenVault): void;
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

  const openVaults = new Map<string, OpenVault>();
  /** Refused on a server of vaults that open with their links: there are no accounts. */
  const notWhenOpen = () => {
    if (opts.open)
      throw new HttpError(403, 'Vaults here open with their links; there is no signing in.');
  };
  /** A served folder of which `user` is an owner (they may run its agents), or nothing. */
  const ownedFolder = (vaultId: string, user: PublicUser) => {
    const served = openVaults.get(vaultId);
    return served && store.role(vaultId, user.id) === 'owner' ? served : undefined;
  };
  const sha = (s: string) => createHash('sha256').update(s).digest();
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
      'GET',
      /^\/api\/info$/,
      // (How the web app knows the server it came from is a Pumice server.)
      async () => (opts.open ? { pumice: true, open: true } : { pumice: true }),
    ],
    [
      'GET',
      /^\/api\/vaults\/([\w-]+)\/folder$/,
      // For the vault's owners: where its folder is, and which agents run in it.
      async (req, _res, m) => {
        const served = ownedFolder(m[1]!, authUser(req));
        if (!served) throw new HttpError(404, 'Not found');
        return { root: served.root, agents: served.agents };
      },
    ],
    [
      'GET',
      /^\/api\/vaults\/([\w-]+)\/link$/,
      // A served folder's link, for whoever is in it (to pass it on; it gives everything).
      async (req, _res, m) => {
        const user = authUser(req);
        const served = openVaults.get(m[1]!);
        if (!served || !store.role(served.vaultId, user.id)) throw new HttpError(404, 'Not found');
        return { key: served.key };
      },
    ],
    [
      'POST',
      /^\/api\/open$/,
      // A vault's link: its role for this browser or device (signed in by an earlier link, or
      // now, under a name of its own).
      async (req) => {
        const {
          vault: vaultId,
          key,
          device,
        } = await json<{
          vault?: string;
          key?: string;
          device?: string;
        }>(req);
        const served = typeof vaultId === 'string' ? openVaults.get(vaultId) : undefined;
        if (!served || typeof key !== 'string' || !timingSafeEqual(sha(key), sha(served.key)))
          throw new HttpError(403, 'This link is not (or no longer) a link to a vault here.');
        const header = req.headers.authorization ?? '';
        const current = header.startsWith('Bearer ')
          ? store.userForToken(header.slice(7))
          : undefined;
        const user =
          current ??
          store.createUser(`device-${randomUUID().slice(0, 12)}@pumice.local`, generatedName());
        // (Who has the link has the vault, as its owner does.)
        const had = store.role(served.vaultId, user.id);
        if (!had) store.addMember(served.vaultId, user.id, 'owner');
        else if (had !== 'owner') store.setRole(served.vaultId, user.id, 'owner');
        const vault = store.vaultsOf(user.id).find((v) => v.id === served.vaultId)!;
        const token = current
          ? header.slice(7)
          : store.createSession(user.id, String(device ?? 'unknown'));
        return { token, user, vault };
      },
    ],
    [
      'POST',
      /^\/api\/auth\/request$/,
      async (req) => {
        notWhenOpen();
        const { email } = await json<{ email?: string }>(req);
        const address = email?.trim().toLowerCase() ?? '';
        if (!EMAIL.test(address)) throw new HttpError(400, 'Enter a valid email address');
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        store.setLoginCode(address, code, 15 * 60 * 1000);
        await sendCode(address, code);
        // Without a way to send them (no email yet), codes are printed where the server runs.
        const where = opts.sendLoginCode ? {} : { where: 'log' as const };
        return opts.devLogin ? { sent: true, code, ...where } : { sent: true, ...where };
      },
    ],
    [
      'POST',
      /^\/api\/auth\/verify$/,
      async (req) => {
        notWhenOpen();
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
        notWhenOpen();
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
        notWhenOpen();
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
        notWhenOpen();
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
    if (!route && opts.webApp && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!path.startsWith('/api/')) {
        void serveWebApp(opts.webApp, path, res);
        return;
      }
    }
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
    if (url.pathname !== '/sync' && url.pathname !== '/agents') return socket.destroy();
    const token = url.searchParams.get('token') ?? '';
    const user = token ? store.userForToken(token) : undefined;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname === '/agents') {
      // The agent chats of a served folder, for its owners (see sessions.ts).
      const served = ownedFolder(url.searchParams.get('vault') ?? '', user);
      if (!served?.chats) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // A malformed frame is that connection's end, not the server's.
        ws.on('error', () => ws.terminate());
        const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 30_000);
        ws.on('close', () => clearInterval(ping));
        served.chats!.connect(ws, { id: user.id, name: user.name }).catch((e: unknown) => {
          console.error('[pumice-server] agent chats:', e);
          ws.terminate();
        });
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A malformed frame is that connection's end, not the server's.
      ws.on('error', () => ws.terminate());
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
    addOpenVault(vault) {
      openVaults.set(vault.vaultId, vault);
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      hub.close();
      store.close();
    },
  };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * A file of the web app; the page itself for every other address. An invite link opens the app
 * with the invite (`/invite/<token>` stays the link: the desktop app takes it as it is).
 */
async function serveWebApp(dir: string, path: string, res: ServerResponse): Promise<void> {
  const invite = /^\/invite\/([\w-]+)\/?$/.exec(path);
  if (invite) {
    res.writeHead(302, { Location: `/#invite=${invite[1]}` }).end();
    return;
  }
  const root = resolve(dir);
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // (Not an address of a file: the page.)
  }
  let file = resolve(root, `.${decoded}`);
  if (file !== root && !file.startsWith(root + sep)) file = root;
  const found = await stat(file).catch(() => undefined);
  if (!found?.isFile()) file = join(root, 'index.html');
  try {
    const data = await readFile(file);
    res
      .writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        // The page is looked at anew each time; its scripts have their hash in their names.
        'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000',
      })
      .end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('The web app is not built.');
  }
}

const ADJECTIVES =
  'Amber Brisk Calm Clever Curious Daring Eager Gentle Golden Happy Humble Jolly Keen Kind Lively Lucky Mellow Merry Nimble Patient Quiet Rapid Silver Steady Sunny Swift Tidy Witty'.split(
    ' ',
  );
const ANIMALS =
  'Badger Beaver Crane Dolphin Falcon Ferret Finch Fox Gecko Heron Ibis Koala Lark Lemur Lynx Marten Moose Newt Otter Owl Panda Puffin Raven Seal Stoat Swan Tapir Wren'.split(
    ' ',
  );
/** A name for a browser or device that opened the vault with its key (as on Excalidraw). */
const generatedName = () =>
  `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${ANIMALS[randomInt(ANIMALS.length)]}`;
