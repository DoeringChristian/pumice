import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';

let dir: string;
let server: RunningServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pumice-web-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Pumice</title>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'secret');
  server = await startServer({ dataDir: join(dir, 'data'), webApp: web });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the web app from the server', () => {
  it('serves the page, its files, and the page for other addresses', async () => {
    const page = await fetch(`${server.url}/`);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>Pumice</title>');
    const js = await fetch(`${server.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await (await fetch(`${server.url}/somewhere/else`)).text()).toContain('<title>');
  });

  it('sends invite links into the app, and says it is a Pumice server', async () => {
    const r = await fetch(`${server.url}/invite/abc-DEF_1`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/#invite=abc-DEF_1');
    expect(await (await fetch(`${server.url}/api/info`)).json()).toEqual({ pumice: true });
    expect((await fetch(`${server.url}/api/nothing`)).status).toBe(404);
  });

  it('serves nothing outside the web app', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt'])
      expect(await (await fetch(`${server.url}${path}`)).text()).not.toContain('secret');
  });
});
