import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { excalidrawAssets } from '../../packages/app/build/excalidraw-assets';
import { workerSafe } from '../../packages/app/build/worker-safe';

/**
 * What the built page may load: its own scripts (and plugins, as blobs), and any server over
 * https, since everyone has their own. Not in development, which puts scripts into the page.
 */
const policy: Plugin = {
  name: 'content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      injectTo: 'head-prepend',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob: https:; media-src 'self' blob: https:; object-src blob:; " +
          "frame-src blob:; worker-src 'self' blob:; font-src 'self' data:; " +
          "connect-src 'self' blob: data: https: wss: http://localhost:* ws://localhost:* " +
          'http://127.0.0.1:* ws://127.0.0.1:*',
      },
    },
  ],
};

export default defineConfig({
  // Served from any folder (GitHub Pages: /pumice/).
  base: './',
  plugins: [react(), excalidrawAssets(), workerSafe(), policy],
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
