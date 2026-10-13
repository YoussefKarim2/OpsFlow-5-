import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

/**
 * One id per build, stamped into the JavaScript and written to dist/build.json
 * for the server's health endpoint, so an open tab can tell when a newer
 * build is live (see src/lib/deploy-guard.ts). The deploy's commit SHA when
 * the host provides one, otherwise the build time.
 */
const buildId = (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? '').slice(0, 12) || Date.now().toString(36);
const writeBuildId = (): Plugin => ({
  name: 'opsflow-build-id',
  closeBundle() {
    fs.writeFileSync(path.resolve(__dirname, 'dist/build.json'), JSON.stringify({ id: buildId, builtAt: new Date().toISOString() }));
  },
});

export default defineConfig({
  plugins: [react(), writeBuildId()],
  define: { __BUILD_ID__: JSON.stringify(process.env.NODE_ENV === 'production' ? buildId : 'dev') },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy in dev so the browser never needs CORS or a separate origin.
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
