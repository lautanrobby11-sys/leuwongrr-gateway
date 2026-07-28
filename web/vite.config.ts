import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Four entry points instead of a client-side router: each surface is a
 * separate document, so /chat never downloads the admin bundle and the gateway
 * can keep serving plain files with no rewrite rules.
 *
 * `base` must match the allowlisted asset route in src/policy/allowlist.ts.
 */
export default defineConfig({
  plugins: [react()],
  base: '/console/',
  build: {
    outDir: resolve(import.meta.dirname, '../dist/public'),
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        admin: resolve(import.meta.dirname, 'admin.html'),
        member: resolve(import.meta.dirname, 'member.html'),
        chat: resolve(import.meta.dirname, 'chat.html'),
        login: resolve(import.meta.dirname, 'login.html')
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/console/api': 'http://127.0.0.1:2080',
      '/v1': 'http://127.0.0.1:2080'
    }
  }
});
