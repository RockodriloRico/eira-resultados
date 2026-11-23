import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Solo en `vite dev`: sirve el config.json local (identidad sintética, API por proxy). El build no
// incluye config.json; en AWS se genera por entorno con `npm run frontend:config`.
const localRuntimeConfig = (): Plugin => ({
  name: 'eira-local-runtime-config',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/config.json', (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ stage: 'local', apiBaseUrl: '', admin: { mode: 'local' } }));
    });
  },
});

export default defineConfig({
  plugins: [react(), localRuntimeConfig()],
  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },
  // Demo local: Vite y la API solo en 127.0.0.1; la API se alcanza por proxy (mismo origen).
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': 'http://127.0.0.1:3001',
      '/local-documents': 'http://127.0.0.1:3001',
    },
  },
  build: {
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
