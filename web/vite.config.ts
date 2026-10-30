import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Vendored assets live outside the client package: they are repository-level
 * files, not client source. The alias lets the stylesheet reference them and
 * still go through the bundler (hashing, inlining rules). */
const repositoryAssets = fileURLToPath(new URL('../assets', import.meta.url));
const brandHash = createHash('sha256')
  .update(readFileSync(new URL('../src/assets/branding/openbutler.svg', import.meta.url)))
  .digest('hex')
  .slice(0, 12);

/**
 * The client is served by the OpenButler web server from `dist/client`, which means
 * every change needs a build. In development Vite serves the client itself and
 * forwards the API to the running server, so editing a component is instant.
 *
 * `changeOrigin` stays off on purpose: the server accepts a mutation only when
 * the request's Origin names the host it arrived on, and rewriting the host to
 * the API port would make every POST look cross-origin.
 */
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'openbutler-brand-favicon-revision',
      transformIndexHtml: (html: string) => html.replaceAll('__OPENBUTLER_BRAND_HASH__', brandHash),
    },
  ],
  base: './',
  resolve: {
    alias: { '@assets': repositoryAssets },
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:45278', changeOrigin: false, ws: true },
      '/brand': { target: 'http://127.0.0.1:45278', changeOrigin: false },
      '/favicon.ico': { target: 'http://127.0.0.1:45278', changeOrigin: false },
      '/favicon-32x32.png': { target: 'http://127.0.0.1:45278', changeOrigin: false },
      '/apple-touch-icon.png': { target: 'http://127.0.0.1:45278', changeOrigin: false },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    cssMinify: true,
    reportCompressedSize: true,
  },
});
