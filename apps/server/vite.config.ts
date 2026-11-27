import { defineConfig } from 'vite';

// One file to run with Node: the server and the parts of the app it runs for a served folder
// (core.collab's sync, documents, the vault), which Node can't run as they are written.
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    target: 'node22',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'main.js',
        // Yjs's helpers look for the browser's localStorage when loaded; Node (22+) has one
        // only with --localstorage-file and warns on every start when it is looked at.
        // (After a shebang: `pumice-server` is this file.)
        banner:
          "#!/usr/bin/env node\nObject.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });",
      },
    },
  },
  // Everything in the file (one copy of Yjs), except `ws` and its optional native helpers.
  ssr: { noExternal: true, external: ['ws'] },
});
