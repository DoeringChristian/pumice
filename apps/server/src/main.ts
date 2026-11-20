import { startServer } from './server.ts';

const port = Number(process.env.PORT ?? 8787);
const server = await startServer({
  dataDir: process.env.PUMICE_DATA ?? './data',
  port,
  host: process.env.HOST ?? '0.0.0.0',
  devLogin: process.env.PUMICE_DEV_LOGIN === '1',
  publicUrl: process.env.PUBLIC_URL,
});
console.log(
  `[pumice-server] listening on ${server.url} (data in ${process.env.PUMICE_DATA ?? './data'})`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
