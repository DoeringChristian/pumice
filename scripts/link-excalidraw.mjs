// Links the Excalidraw fork (vendor/excalidraw, built by `npm run build:excalidraw`) as
// node_modules/@excalidraw/excalidraw, for plugins/core-excalidraw. It is not an npm
// dependency: npm would install the fork's own packages (@excalidraw/common, ...) from the
// registry, where those versions are not; the fork has them in its own node_modules.
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'vendor/excalidraw/packages/excalidraw');
const link = join(root, 'node_modules/@excalidraw/excalidraw');
if (!existsSync(target)) {
  console.warn('[link-excalidraw] vendor/excalidraw is missing: git submodule update --init');
  process.exit(0);
}
mkdirSync(dirname(link), { recursive: true });
try {
  if (lstatSync(link)) rmSync(link, { recursive: true, force: true });
} catch {
  // (Not there yet.)
}
// (A junction on Windows: no rights needed for it.)
symlinkSync(
  process.platform === 'win32' ? target : relative(dirname(link), target),
  link,
  process.platform === 'win32' ? 'junction' : 'dir',
);
