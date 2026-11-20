import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';
import { excalidrawAssets } from '../../packages/app/build/excalidraw-assets';
import { workerSafe } from '../../packages/app/build/worker-safe';

export default defineConfig({
  main: {
    // Workspace packages are TypeScript sources: bundle them instead of requiring them at runtime.
    plugins: [
      externalizeDepsPlugin({ exclude: ['@pumice/platform', '@pumice/platform-electron'] }),
    ],
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({ exclude: ['@pumice/platform', '@pumice/platform-electron'] }),
    ],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), excalidrawAssets(), workerSafe()],
    worker: { plugins: () => [workerSafe()] },
    resolve: {
      dedupe: [
        'react',
        'react-dom',
        'yjs',
        '@codemirror/state',
        '@codemirror/view',
        '@codemirror/language',
      ],
    },
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
