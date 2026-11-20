import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISSUER, createChatGpt, sanitizeResponsesBody, verifyIdToken } from '../src/main/chatgpt';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims: Record<string, unknown>): string {
  const input = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** A stand-in for OpenAI: token endpoint, JWKS, models, Responses stream. */
function fakeOpenAI(port: number) {
  const calls: Array<{ url: string; auth?: string; body?: string }> = [];
  const state = { access: 0, nonce: '', failNext401: false };
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const body = init?.body ? String(init.body) : undefined;
    calls.push({ url, ...(auth ? { auth } : {}), ...(body ? { body } : {}) });
    if (url.endsWith('/.well-known/openid-configuration'))
      return json({ jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    if (url === `${ISSUER}/jwks`) return json({ keys: [jwk] });
    if (url === `${ISSUER}/revoke`) return json({});
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(body);
      state.access++;
      return json({
        access_token: `access-${state.access}`,
        refresh_token: `refresh-${state.access}`,
        expires_in: 3600,
        scope: 'openid chatgpt.tokens.use.direct',
        ...(form.get('grant_type') === 'authorization_code'
          ? {
              id_token: idToken({
                iss: ISSUER,
                aud: form.get('client_id'),
                exp: Math.floor(Date.now() / 1000) + 600,
                nonce: state.nonce,
                email: 'me@example.com',
              }),
            }
          : {}),
      });
    }
    if (url.endsWith('/v1/models'))
      return json({
        data: [
          { slug: 'm1', display_name: 'Model One' },
          { id: 'hidden', visibility: 'hide' },
        ],
      });
    if (url.endsWith('/v1/responses')) {
      if (state.failNext401) {
        state.failNext401 = false;
        return json({ error: { message: 'expired' } }, 401);
      }
      const sse =
        'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n' +
        ': keep-alive\n\n' +
        'data: {"type":"response.output_text.delta","delta":"lo"}\r\n\r\n' +
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\ndata: [DONE]\n\n';
      // Split mid-event to exercise the stream parser.
      const bytes = new TextEncoder().encode(sse);
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes.slice(0, 37));
            c.enqueue(bytes.slice(37));
            c.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
  void port;
  return { fetchImpl, calls, state };
}

describe('Sign in with ChatGPT (main process)', () => {
  it('signs in through the loopback callback, streams a response, refreshes and signs out', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pumice-chatgpt-'));
    const port = 47900 + Math.floor(Math.random() * 90);
    const openai = fakeOpenAI(port);
    let opened = '';
    const chatgpt = createChatGpt({
      dataDir,
      port,
      fetchImpl: openai.fetchImpl,
      openExternal: async (url) => void (opened = url),
    });
    expect(await chatgpt.status()).toEqual({ signedIn: false, email: null, planUsage: false });
    await expect(chatgpt.models()).rejects.toMatchObject({ reauth: true });

    // Login: the browser would open OpenAI's page, which redirects to the loopback callback.
    await chatgpt.login();
    const authorize = new URL(opened);
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorize.searchParams.get('agent_name_hint')).toBe('Pumice');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${port}/auth/callback`,
    );
    expect(authorize.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    openai.state.nonce = authorize.searchParams.get('nonce')!;
    const callback = `http://127.0.0.1:${port}/auth/callback?code=abc&state=${authorize.searchParams.get('state')}&client_id=client-123`;
    const page = await (await fetch(callback)).text();
    expect(page).toContain('Signed in with ChatGPT');
    expect(await chatgpt.status()).toEqual({
      signedIn: true,
      email: 'me@example.com',
      planUsage: true,
    });

    // Tokens are in an owner-only file; the code was exchanged with the PKCE verifier.
    const authFile = join(dataDir, 'chatgpt', 'auth.json');
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(authFile, 'utf8'))).toMatchObject({ clientId: 'client-123' });
    const exchange = new URLSearchParams(
      openai.calls.find((c) => c.url.endsWith('/oauth/token'))!.body,
    );
    expect(exchange.get('code')).toBe('abc');
    expect(exchange.get('code_verifier')!.length).toBeGreaterThan(40);
    // The callback server is gone after use.
    await expect(fetch(callback)).rejects.toBeTruthy();

    expect(await chatgpt.models()).toEqual([{ id: 'm1', name: 'Model One' }]);

    // A streamed request, with a 401 first: the token is refreshed once and the call retried.
    openai.state.failNext401 = true;
    const events: Array<Record<string, unknown>> = [];
    await chatgpt.responses(
      { model: 'm1', input: [], temperature: 1, store: true },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(events.map((e) => e.type)).toEqual([
      'response.output_text.delta',
      'response.output_text.delta',
      'response.completed',
    ]);
    expect(
      events
        .slice(0, 2)
        .map((e) => e.delta)
        .join(''),
    ).toBe('Hello');
    const sent = openai.calls.filter((c) => c.url.endsWith('/v1/responses'));
    expect(sent.map((c) => c.auth)).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(JSON.parse(sent[1]!.body!)).toEqual({
      model: 'm1',
      input: [],
      store: false,
      stream: true,
    });

    // A second sign-in reuses the registered client.
    await chatgpt.login();
    expect(new URL(opened).searchParams.get('client_id')).toBe('client-123');
    chatgpt.dispose();

    await chatgpt.logout();
    expect((await chatgpt.status()).signedIn).toBe(false);
    expect(JSON.parse(readFileSync(authFile, 'utf8'))).toEqual({
      clientId: 'client-123',
      email: 'me@example.com',
    });
  });

  it('rejects ID tokens with a bad signature, audience or nonce', async () => {
    const getJwks = async () => ({ keys: [jwk] });
    const claims = { iss: ISSUER, aud: 'c', exp: Math.floor(Date.now() / 1000) + 60, nonce: 'n' };
    await expect(
      verifyIdToken(idToken(claims), { clientId: 'c', nonce: 'n', getJwks }),
    ).resolves.toMatchObject({ aud: 'c' });
    await expect(
      verifyIdToken(idToken(claims), { clientId: 'other', nonce: 'n', getJwks }),
    ).rejects.toThrow('another client');
    await expect(
      verifyIdToken(idToken(claims), { clientId: 'c', nonce: 'x', getJwks }),
    ).rejects.toThrow('nonce');
    const forged = idToken(claims).replace(
      /\.[^.]+$/,
      `.${Buffer.from('nope').toString('base64url')}`,
    );
    await expect(verifyIdToken(forged, { clientId: 'c', nonce: 'n', getJwks })).rejects.toThrow(
      'signature',
    );
  });

  it('strips request fields the plan route rejects', () => {
    expect(
      sanitizeResponsesBody({
        model: 'm',
        temperature: 1,
        previous_response_id: 'x',
        store: true,
        stream: false,
      }),
    ).toEqual({
      model: 'm',
      store: false,
      stream: true,
    });
  });
});
