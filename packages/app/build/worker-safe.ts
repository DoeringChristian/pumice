import type { Plugin } from 'vite';

/**
 * Packages whose `browser` build needs the DOM. Vite resolves workers with the `browser`
 * condition too, so the metadata parser worker would crash on `document`; their plain builds
 * work everywhere.
 */
const DOM_BUILDS: Record<string, [from: string, to: string]> = {
  'decode-named-character-reference': ['index.dom.js', 'index.js'],
};

export function workerSafe(): Plugin {
  return {
    name: 'pumice-worker-safe',
    enforce: 'pre',
    // Dev pre-bundles dependencies with esbuild, which doesn't run Vite plugins.
    config: () => ({
      optimizeDeps: {
        esbuildOptions: {
          plugins: [
            {
              name: 'pumice-worker-safe',
              setup(build) {
                const filter = new RegExp(`^(${Object.keys(DOM_BUILDS).join('|')})$`);
                build.onResolve({ filter }, async (args) => {
                  if (args.pluginData === 'pumice-worker-safe') return undefined;
                  const swap = DOM_BUILDS[args.path]!;
                  const r = await build.resolve(args.path, {
                    kind: args.kind,
                    importer: args.importer,
                    resolveDir: args.resolveDir,
                    pluginData: 'pumice-worker-safe',
                  });
                  return r.errors.length ? undefined : { path: r.path.replace(swap[0], swap[1]) };
                });
              },
            },
          ],
        },
      },
    }),
    async resolveId(source, importer, options) {
      const swap = DOM_BUILDS[source];
      if (!swap) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return { ...resolved, id: resolved.id.replace(swap[0], swap[1]) };
    },
  };
}
