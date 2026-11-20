import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { excalidrawAssets } from '../../packages/app/build/excalidraw-assets';
import { workerSafe } from '../../packages/app/build/worker-safe';

export default defineConfig({
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
  build: { target: ['es2022', 'safari16'] },
  server: { port: 5299 },
});
