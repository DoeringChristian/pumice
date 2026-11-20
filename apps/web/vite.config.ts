import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { excalidrawAssets } from '../../packages/app/build/excalidraw-assets';
import { workerSafe } from '../../packages/app/build/worker-safe';

export default defineConfig({
  plugins: [react(), excalidrawAssets(), workerSafe()],
  worker: { plugins: () => [workerSafe()] },
  // Plugins live in sibling workspace packages; make sure they share one React and one CodeMirror.
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
  build: { target: 'es2022' },
  server: { port: 5199 },
});
