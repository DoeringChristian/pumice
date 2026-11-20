// Sign in with ChatGPT — plan usage for the built-in assistant.
//
// OpenAI's open-source flow lets a user spend their ChatGPT plan in this app instead of paying
// for an API key (https://developers.openai.com/siwc/token-sharing-open-source). Its rules shape
// this module: the OAuth redirect must be an HTTP loopback callback on 127.0.0.1, and
// access/refresh/ID tokens must stay out of the page. So the main process registers the install,
// runs the login, keeps the tokens on disk (owner-only file), refreshes them and makes the
// Responses API calls; the renderer only ever sees the streamed model output.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const RESPONSES_URL = `${RESOURCE}/responses`;
const MODELS_URL = `${RESOURCE}/models`;
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const AGENT_NAME = 'Pumice';
const CALLBACK_PATH = '/auth/callback';
/** The loopback port of the OAuth callback (the redirect URI must be stable for the client). */
export const CALLBACK_PORT = 47835;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/** Fields the plan-usage route rejects (per OpenAI's models-and-inference doc). */
export const UNSUPPORTED_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
];

/** Refresh failures that mean the user has to sign in again. */
const REAUTH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

export class ChatGptError extends Error {
  constructor(
    message: string,
    readonly reauth = false,
    readonly code?: string,
  ) {
    super(message);
  }
}

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url');
const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

interface Jwks {
  keys?: Array<crypto.JsonWebKey & { kid?: string }>;
}

/** Verifies an ID token's RS256 signature and its claims. */
export async function verifyIdToken(
  idToken: string,
  opts: { clientId: string; nonce?: string; getJwks: () => Promise<Jwks>; now?: number },
): Promise<Record<string, unknown>> {
  const [h, p, s] = String(idToken).split('.');
  if (!h || !p || !s) throw new Error('Malformed ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  if (header.alg !== 'RS256') throw new Error(`Unexpected ID token algorithm ${header.alg}`);
  const { keys = [] } = await opts.getJwks();
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new Error('ID token signed with an unknown key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')))
    throw new Error('ID token signature is invalid');
  if (payload.iss !== ISSUER) throw new Error('ID token has the wrong issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.clientId)) throw new Error('ID token was issued to another client');
  const now = opts.now ?? Date.now();
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now - 60_000)
    throw new Error('ID token has expired');
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce)
    throw new Error('ID token nonce does not match');
  return payload;
}

/** Makes a Responses request acceptable to the plan route. */
export function sanitizeResponsesBody(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(body && typeof body === 'object' ? body : {}) };
  for (const field of UNSUPPORTED_FIELDS) delete out[field];
  out.store = false;
  out.stream = true;
  return out;
}

export const hasPlanScope = (scope: unknown) =>
  String(scope ?? '')
    .split(/\s+/)
    .includes(PLAN_SCOPE);

interface Tokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
  expiresAt: number;
}

interface AuthFile {
  clientId?: string;
  email?: string | null;
  tokens?: Tokens;
}

export interface ChatGptStatus {
  signedIn: boolean;
  email: string | null;
  /** False when the user signed in but did not allow plan usage. */
  planUsage: boolean;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJsonPrivate(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  '<body style="font:15px system-ui;max-width:28rem;margin:4rem auto;color:#222">' +
  `<h2 style="font-weight:600">${title}</h2><p>${body}</p></body>`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface ChatGptOptions {
  /** Folder for the registration and the tokens (the app's user data folder). */
  dataDir: string;
  port?: number;
  fetchImpl?: typeof fetch;
  openExternal(url: string): Promise<void>;
}

export function createChatGpt(opts: ChatGptOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const port = opts.port ?? CALLBACK_PORT;
  const dir = path.join(opts.dataDir, 'chatgpt');
  const hostFile = path.join(dir, 'host.json');
  const authFile = path.join(dir, 'auth.json');
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const pending = new Map<string, { verifier: string; nonce: string; createdAt: number }>();
  let jwksCache: { at: number; jwks: Jwks; config: { revocation_endpoint?: string } } | null = null;
  let refreshing: Promise<AuthFile> | null = null;
  let server: http.Server | null = null;
  let serverTimer: NodeJS.Timeout | undefined;

  async function hostId(): Promise<string> {
    const saved = await readJson<{ hostId?: string }>(hostFile);
    if (saved?.hostId) return saved.hostId;
    const id = `urn:uuid:${crypto.randomUUID()}`;
    await writeJsonPrivate(hostFile, { hostId: id });
    return id;
  }

  const readAuth = async (): Promise<AuthFile> => (await readJson<AuthFile>(authFile)) ?? {};
  const writeAuth = (auth: AuthFile) => writeJsonPrivate(authFile, auth);

  async function getJwks(): Promise<Jwks> {
    if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.jwks;
    const config = (await (
      await fetchImpl(`${ISSUER}/.well-known/openid-configuration`)
    ).json()) as {
      jwks_uri: string;
      revocation_endpoint?: string;
    };
    const jwks = (await (await fetchImpl(config.jwks_uri)).json()) as Jwks;
    jwksCache = { at: Date.now(), jwks, config };
    return jwks;
  }

  async function authorizeUrl(): Promise<string> {
    for (const [state, entry] of pending)
      if (Date.now() - entry.createdAt > LOGIN_TTL_MS) pending.delete(state);
    const { verifier, challenge } = pkcePair();
    const state = randomToken(24);
    const nonce = randomToken(24);
    pending.set(state, { verifier, nonce, createdAt: Date.now() });
    const auth = await readAuth();
    const params = new URLSearchParams({
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ext_agent_host_id: await hostId(),
    });
    if (auth.clientId) {
      // Registered before: reuse the issued client, never register another app.
      params.set('client_id', auth.clientId);
      if (auth.email) params.set('login_hint', auth.email);
    } else {
      params.set('client_id', 'dynamic_agent_client');
      params.set('agent_name_hint', AGENT_NAME);
    }
    return `${AUTHORIZE_URL}?${params}`;
  }

  async function tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ChatGptError(
        String(json.error_description || json.error || `Token endpoint answered ${res.status}`),
        false,
        typeof json.error === 'string' ? json.error : undefined,
      );
    }
    return json;
  }

  const tokensFrom = (json: Record<string, unknown>, previous: Partial<Tokens> = {}): Tokens => ({
    accessToken: String(json.access_token),
    refreshToken: (json.refresh_token as string | undefined) ?? previous.refreshToken,
    idToken: (json.id_token as string | undefined) ?? previous.idToken,
    scope: (json.scope as string | undefined) ?? previous.scope,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });

  async function finishLogin(
    query: URLSearchParams,
  ): Promise<{ email: string | null; planUsage: boolean }> {
    const error = query.get('error');
    if (error) {
      throw new Error(
        error === 'access_denied'
          ? 'Sign-in was cancelled.'
          : query.get('error_description') || error,
      );
    }
    const state = query.get('state') ?? '';
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || Date.now() - entry.createdAt > LOGIN_TTL_MS)
      throw new Error('This sign-in link expired. Start again from Pumice.');
    const auth = await readAuth();
    const clientId = query.get('client_id') || auth.clientId;
    if (!clientId) throw new Error('OpenAI did not return a client id.');
    // Keep the registration before exchanging the code, as OpenAI asks, so a failed exchange
    // does not register the app again next time.
    if (clientId !== auth.clientId) await writeAuth({ ...auth, clientId });
    const json = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: query.get('code') ?? '',
      code_verifier: entry.verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE,
    });
    const claims = await verifyIdToken(String(json.id_token), {
      clientId,
      nonce: entry.nonce,
      getJwks,
    });
    const tokens = tokensFrom(json);
    const email = typeof claims.email === 'string' ? claims.email : null;
    await writeAuth({ clientId, email, tokens });
    return { email, planUsage: hasPlanScope(tokens.scope) };
  }

  function stopServer(): void {
    clearTimeout(serverTimer);
    server?.close();
    server = null;
  }

  /** The OAuth redirect lands here, on 127.0.0.1, in the user's browser. */
  function startServer(): Promise<void> {
    if (server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        const host = (req.headers.host ?? '').toLowerCase();
        // Loopback peer and a loopback Host header (against DNS rebinding).
        const local =
          ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') &&
          /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
        if (!local || url.pathname !== CALLBACK_PATH) {
          res.writeHead(local ? 404 : 403).end();
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        finishLogin(url.searchParams)
          .then(({ email, planUsage }) => {
            res.end(
              page(
                'Signed in with ChatGPT',
                planUsage
                  ? `Pumice can now use ${email ? `${escapeHtml(email)}’s` : 'your'} ChatGPT plan. You can close this tab and return to Pumice.`
                  : 'You signed in, but did not allow plan usage, so the assistant cannot run on your plan. Sign in again from Pumice and allow it.',
              ),
            );
          })
          .catch((e: Error) => {
            res.statusCode = 400;
            res.end(page('Sign-in failed', escapeHtml(e.message)));
          })
          .finally(stopServer);
      });
      s.once('error', (e: NodeJS.ErrnoException) =>
        reject(
          new Error(
            e.code === 'EADDRINUSE'
              ? `Port ${port} is in use by another program, so sign-in can't complete. Close it and try again.`
              : e.message,
          ),
        ),
      );
      s.listen(port, '127.0.0.1', () => {
        server = s;
        serverTimer = setTimeout(stopServer, LOGIN_TTL_MS);
        resolve();
      });
    });
  }

  async function refresh(auth: AuthFile): Promise<AuthFile> {
    try {
      const json = await tokenRequest({
        grant_type: 'refresh_token',
        client_id: auth.clientId!,
        refresh_token: auth.tokens!.refreshToken!,
        resource: RESOURCE,
      });
      const next = { ...auth, tokens: tokensFrom(json, auth.tokens) };
      await writeAuth(next);
      return next;
    } catch (err) {
      if (err instanceof ChatGptError && err.code && REAUTH_ERRORS.has(err.code)) {
        await writeAuth({ clientId: auth.clientId, email: auth.email });
        throw new ChatGptError('Your ChatGPT sign-in expired. Sign in again.', true);
      }
      throw err;
    }
  }

  /**
   * A valid access token, refreshed when close to expiry (one refresh at a time: refresh tokens
   * rotate, so a second concurrent refresh would reuse an already-spent token).
   */
  async function accessToken(force = false): Promise<string> {
    const auth = await readAuth();
    if (!auth.tokens?.accessToken) throw new ChatGptError('Not signed in with ChatGPT.', true);
    const due = force || auth.tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS;
    if (!due || !auth.tokens.refreshToken || !auth.clientId) return auth.tokens.accessToken;
    refreshing ??= refresh(auth).finally(() => {
      refreshing = null;
    });
    return (await refreshing).tokens!.accessToken;
  }

  async function upstream(url: string, init: RequestInit): Promise<Response> {
    const call = async (token: string) =>
      fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    let res = await call(await accessToken());
    if (res.status === 401) res = await call(await accessToken(true));
    return res;
  }

  return {
    async status(): Promise<ChatGptStatus> {
      const auth = await readAuth();
      return {
        signedIn: !!auth.tokens?.accessToken,
        email: auth.email ?? null,
        planUsage: hasPlanScope(auth.tokens?.scope),
      };
    },

    /** Opens OpenAI's consent page in the browser; `status()` turns signed-in when done. */
    async login(): Promise<void> {
      await startServer();
      await opts.openExternal(await authorizeUrl());
    },

    async logout(): Promise<void> {
      const auth = await readAuth();
      const token = auth.tokens?.refreshToken;
      if (token && auth.clientId) {
        try {
          if (!jwksCache) await getJwks();
          const endpoint = jwksCache?.config.revocation_endpoint;
          if (endpoint) {
            await fetchImpl(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token,
                token_type_hint: 'refresh_token',
                client_id: auth.clientId,
              }),
            });
          }
        } catch {
          // Revocation is best effort; the local copy is removed regardless.
        }
      }
      await writeAuth({ clientId: auth.clientId, email: auth.email });
    },

    async models(): Promise<Array<{ id: string; name: string }>> {
      const res = await upstream(MODELS_URL, { method: 'GET', headers: {} });
      const json = (await res.json().catch(() => ({}))) as {
        data?: unknown[];
        models?: unknown[];
        error?: { message?: string };
      };
      if (!res.ok) throw new ChatGptError(json.error?.message ?? `OpenAI answered ${res.status}`);
      const list = (json.data ?? json.models ?? []) as Array<{
        id?: string;
        slug?: string;
        display_name?: string;
        visibility?: string;
      }>;
      return list
        .filter((m) => !m.visibility || m.visibility === 'list')
        .map((m) => ({ id: m.slug ?? m.id ?? '', name: m.display_name ?? m.slug ?? m.id ?? '' }))
        .filter((m) => m.id);
    },

    /**
     * One streamed Responses request. Calls `onEvent` with each server-sent event (parsed JSON).
     * A non-2xx answer is reported as a single `{ type: 'http_error', status, body }` event.
     */
    async responses(
      body: unknown,
      onEvent: (event: Record<string, unknown>) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const res = await upstream(RESPONSES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(sanitizeResponsesBody(body)),
        signal,
      });
      if (!res.ok || !res.body) {
        onEvent({
          type: 'http_error',
          status: res.status,
          body: await res.json().catch(() => null),
        });
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
          const data = raw
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data || data === '[DONE]') continue;
          try {
            onEvent(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // keep-alives and junk
          }
        }
      }
    },

    dispose: stopServer,
  };
}

export type ChatGpt = ReturnType<typeof createChatGpt>;
