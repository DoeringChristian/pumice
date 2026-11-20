#!/usr/bin/env node
/**
 * pumice-plugin — scaffold, build and live-develop Pumice plugins.
 *
 *   pumice-plugin init <dir> [--id my.plugin] [--name "My plugin"]
 *   pumice-plugin build [dir]                 → <dir>/dist/{manifest.json,main.js,styles.css}
 *   pumice-plugin dev [dir] --vault <path>    → rebuilds on change into <vault>/.pumice/extensions/<id>/
 *                                               (the running app reloads the plugin by itself)
 */
import { context, build as esbuild } from 'esbuild';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'template');
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Provided by the app at runtime (see packages/app/src/shared-modules.ts); never bundled. */
const SHARED = [
  '@pumice/api',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/markdown',
  'yjs',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
];

const sharedModules = {
  name: 'pumice-shared-modules',
  setup(b) {
    const filter = new RegExp(`^(${SHARED.map((s) => s.replace(/[/.]/g, '\\$&')).join('|')})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'pumice-shared' }));
    b.onLoad({ filter: /.*/, namespace: 'pumice-shared' }, (args) => ({
      contents: `const m = globalThis.pumiceModules && globalThis.pumiceModules[${JSON.stringify(args.path)}];
if (!m) throw new Error('Pumice does not provide ${args.path} (plugin built for a newer app?)');
module.exports = m;`,
      loader: 'js',
    }));
  },
};

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function readManifest(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  for (const key of ['id', 'name', 'version', 'api']) {
    if (typeof manifest[key] !== 'string' || !manifest[key])
      throw new Error(`manifest.json: "${key}" is required`);
  }
  if (!ID_PATTERN.test(manifest.id)) throw new Error(`manifest.json: invalid id "${manifest.id}"`);
  if (manifest.id.startsWith('core.'))
    throw new Error('manifest.json: the "core." prefix is reserved');
  return manifest;
}

async function entryOf(dir) {
  for (const name of ['src/main.ts', 'src/main.tsx', 'src/main.js', 'main.ts', 'main.js']) {
    if (await exists(join(dir, name))) return join(dir, name);
  }
  throw new Error('No entry point: create src/main.ts');
}

function esbuildOptions(dir, entry, outdir, production) {
  return {
    entryPoints: { main: entry },
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: production,
    sourcemap: production ? false : 'inline',
    loader: { '.css': 'text', '.svg': 'text' },
    jsx: 'automatic',
    logLevel: 'warning',
    absWorkingDir: dir,
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
    plugins: [sharedModules],
  };
}

async function copyAssets(dir, outdir) {
  await cp(join(dir, 'manifest.json'), join(outdir, 'manifest.json'));
  if (await exists(join(dir, 'styles.css')))
    await cp(join(dir, 'styles.css'), join(outdir, 'styles.css'));
}

async function init(target, flags) {
  const dir = resolve(target ?? '.');
  if ((await exists(dir)) && (await readdir(dir)).length) throw new Error(`${dir} is not empty`);
  const name = typeof flags.name === 'string' ? flags.name : basename(dir).replace(/[-_]/g, ' ');
  const id =
    typeof flags.id === 'string'
      ? flags.id
      : basename(dir)
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-');
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid id "${id}" (use --id)`);
  await mkdir(dir, { recursive: true });
  for (const file of await readdir(TEMPLATE, { recursive: true })) {
    const from = join(TEMPLATE, file);
    if ((await stat(from)).isDirectory()) continue;
    const to = join(dir, file.replace(/\.tpl$/, ''));
    await mkdir(dirname(to), { recursive: true });
    const text = (await readFile(from, 'utf8'))
      .replaceAll('__ID__', id)
      .replaceAll('__NAME__', name);
    await writeFile(to, text);
  }
  console.log(`Created ${name} (${id}) in ${dir}

Next:
  cd ${target ?? '.'}
  npm install
  npx pumice-plugin dev --vault /path/to/your/vault`);
}

async function build(target) {
  const dir = resolve(target ?? '.');
  const manifest = await readManifest(dir);
  const outdir = join(dir, 'dist');
  await mkdir(outdir, { recursive: true });
  await esbuild(esbuildOptions(dir, await entryOf(dir), outdir, true));
  await copyAssets(dir, outdir);
  console.log(`Built ${manifest.id} ${manifest.version} → ${outdir}`);
}

async function dev(target, flags) {
  const dir = resolve(target ?? '.');
  if (typeof flags.vault !== 'string') throw new Error('Pass --vault <path to your vault>');
  const manifest = await readManifest(dir);
  const outdir = join(resolve(flags.vault), '.pumice', 'extensions', manifest.id);
  await mkdir(outdir, { recursive: true });
  const ctx = await context({
    ...esbuildOptions(dir, await entryOf(dir), outdir, false),
    plugins: [
      sharedModules,
      {
        name: 'pumice-copy-assets',
        setup(b) {
          b.onEnd(async (result) => {
            if (result.errors.length) return;
            await copyAssets(dir, outdir);
            console.log(`[${new Date().toLocaleTimeString()}] rebuilt ${manifest.id} → ${outdir}`);
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log(
    `Watching ${dir}. Pumice reloads the plugin after each build (desktop app with the vault open).`,
  );
}

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);
try {
  if (command === 'init') await init(positional[0], flags);
  else if (command === 'build') await build(positional[0]);
  else if (command === 'dev') await dev(positional[0], flags);
  else {
    console.log(`Usage:
  pumice-plugin init <dir> [--id my.plugin] [--name "My plugin"]
  pumice-plugin build [dir]
  pumice-plugin dev [dir] --vault <path>`);
    process.exitCode = command ? 1 : 0;
  }
} catch (e) {
  console.error(`pumice-plugin: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
