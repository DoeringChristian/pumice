/**
 * Vite plugin: serves and bundles Excalidraw's fonts under `excalidraw/fonts/…`, so drawings
 * work offline (Excalidraw would otherwise fetch them from a CDN).
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

function fontsDir(): string {
  // The package's `exports` hide package.json; resolve its entry and walk up to `dist/prod`.
  const require = createRequire(
    join(dirname(fileURLToPath(import.meta.url)), '../../../plugins/core-excalidraw/package.json'),
  );
  const entry = require.resolve('@excalidraw/excalidraw');
  return join(entry.slice(0, entry.lastIndexOf(`${sep}dist${sep}`)), 'dist/prod/fonts');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

export function excalidrawAssets(): Plugin {
  const root = fontsDir();
  return {
    name: 'pumice-excalidraw-assets',
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts/', (req, res, next) => {
        const file = join(root, decodeURIComponent((req.url ?? '').split('?')[0]!));
        if (!file.startsWith(root)) return next();
        try {
          const data = readFileSync(file);
          res.setHeader(
            'Content-Type',
            file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream',
          );
          res.end(data);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const file of walk(root)) {
        this.emitFile({
          type: 'asset',
          fileName: `excalidraw/fonts/${relative(root, file).split(sep).join('/')}`,
          source: readFileSync(file),
        });
      }
    },
  };
}
