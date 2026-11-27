import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentConfigs, allowedAgents, folderProcesses } from './agents.ts';
import { serveFolder, type ServedFolder } from './folder.ts';
import { AgentChats } from './sessions.ts';
import { startServer } from './server.ts';

const USAGE = `Usage: pumice-server [folder ...]

  folder   Serve each folder as a vault: what is written into it reaches everyone who opened
           the vault, what they edit is written into it. Each opens with the link printed on
           start, which also lets the assistant run its agents in the folder.

Environment: PORT (8787), HOST (0.0.0.0), PUBLIC_URL (the address others use),
  PUMICE_DATA (the server's data: ~/.local/share/pumice-server with folders, else ./data),
  PUMICE_AGENTS (more agent command lines the assistant may run, ';'-separated)`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.find((a) => a.startsWith('-'));
if (unknown) {
  console.error(`Unknown option ${unknown}\n\n${USAGE}`);
  process.exit(2);
}
// (Where it was typed: `npm run serve` runs this from the repository's root.)
const folders = args.map((a) => resolve(process.env.INIT_CWD ?? process.cwd(), a));
for (const folder of folders) {
  if (!(existsSync(folder) && statSync(folder).isDirectory())) {
    console.error(`Not a folder: ${folder}`);
    process.exit(2);
  }
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
/** Where the folders' own connections reach the server: where it listens. */
const own = (port: number) => {
  const at = host === '0.0.0.0' || host === '' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${at.includes(':') ? `[${at}]` : at}:${port}`;
};
// The server's data (not in the folders, which stay as they are).
const dataDir =
  process.env.PUMICE_DATA ??
  (folders.length ? join(homedir(), '.local', 'share', 'pumice-server') : './data');
if (folders.length) {
  // The folders' sign-ins and links: private before anything is read or written.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}
// The web app, built beside this (apps/web/dist), or where PUMICE_WEB says.
const web = process.env.PUMICE_WEB ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const webApp = existsSync(join(web, 'index.html')) ? web : undefined;
const server = await startServer({
  webApp,
  dataDir,
  port,
  host,
  open: folders.length > 0,
  devLogin: process.env.PUMICE_DEV_LOGIN === '1',
  publicUrl: process.env.PUBLIC_URL,
});
const address = process.env.PUBLIC_URL ?? `http://localhost:${server.port}`;
console.log(`[pumice-server] listening on ${server.url} (data in ${dataDir})`);
if (!webApp) console.log(`[pumice-server] no web app at ${web} (npm run build -w @pumice/web)`);

const served: Array<{ folder: ServedFolder; chats: AgentChats; stop(): void }> = [];
const agents = allowedAgents();
const configs = agentConfigs(agents);
const link = (vault: string, key: string) => `${address}/#open=${vault}&key=${key}`;
for (const folder of folders) {
  const id = createHash('sha256').update(realpathSync(folder)).digest('hex').slice(0, 16);
  const one = await serveFolder({
    root: folder,
    dataDir: join(dataDir, 'folders', id),
    store: server.store,
    url: own(server.port),
  });
  // Its agent chats: kept here, the agents running in the folder.
  const processes = folderProcesses(one.root, agents);
  const chats = new AgentChats({
    root: one.root,
    fs: one.fs,
    vault: one.vault,
    documents: one.documents,
    index: one.index,
    agents: configs,
    processes,
  });
  served.push({ folder: one, chats, stop: () => processes.stopAll() });
  server.addOpenVault({
    vaultId: one.vaultId,
    name: one.name,
    key: one.key,
    root: one.root,
    chats,
    agents: configs.map((c) => c.name),
  });
  console.log(`\n  ${one.name}: ${link(one.vaultId, one.key)}`);
}
if (served.length)
  console.log(`
  Open it in a browser or in Pumice (Open a shared vault). The link is yours: it also lets the
  assistant run its agents here, as you. Keep it to yourself.
  From another machine: \`ssh -L ${server.port}:localhost:${server.port} <this machine>\`, or \`tailscale serve ${server.port}\`.
`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      for (const one of served) {
        await one.chats.close().catch((e) => console.error('[pumice-server]', e));
        one.stop();
        await one.folder.close().catch((e) => console.error('[pumice-server]', e));
      }
      await server.close();
      process.exit(0);
    })();
  });
}
