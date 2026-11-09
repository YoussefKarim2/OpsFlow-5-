import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

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

/**
 * The text-recognition engine for pictures (screenshots) on the import page.
 *
 * Served from OpsFlow itself rather than a CDN: the page's content policy only
 * allows its own scripts, and a factory network that blocks a CDN would break
 * the import. The folder carries the version, so an upgrade is never mixed
 * with a cached older engine. See src/lib/ocr.ts.
 */
const require = createRequire(import.meta.url);
const pkgDir = (name: string) => path.dirname(require.resolve(`${name}/package.json`));
export const OCR_VERSION: string = require('tesseract.js/package.json').version;
const ocrFiles = (): Array<[string, string]> => [
  ['worker.min.js', path.join(pkgDir('tesseract.js'), 'dist/worker.min.js')],
  ['tesseract-core-lstm.wasm.js', path.join(pkgDir('tesseract.js-core'), 'tesseract-core-lstm.wasm.js')],
  ['tesseract-core-simd-lstm.wasm.js', path.join(pkgDir('tesseract.js-core'), 'tesseract-core-simd-lstm.wasm.js')],
  ['eng.traineddata.gz', path.join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int/eng.traineddata.gz')],
];
const ocrAssets = (): Plugin => ({
  name: 'opsflow-ocr-assets',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const prefix = `/ocr/${OCR_VERSION}/`;
      if (!req.url?.startsWith(prefix)) return next();
      const found = ocrFiles().find(([name]) => req.url === prefix + name);
      if (!found) return next();
      res.setHeader('Content-Type', found[0].endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      fs.createReadStream(found[1]).pipe(res);
    });
  },
  closeBundle() {
    const dir = path.resolve(__dirname, 'dist/ocr', OCR_VERSION);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, from] of ocrFiles()) fs.copyFileSync(from, path.join(dir, name));
  },
});

export default defineConfig({
  plugins: [react(), writeBuildId(), ocrAssets()],
  define: {
    __BUILD_ID__: JSON.stringify(process.env.NODE_ENV === 'production' ? buildId : 'dev'),
    __OCR_VERSION__: JSON.stringify(OCR_VERSION),
  },
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
