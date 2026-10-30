import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// Which version is running, shown in the app (Mer / Innstillinger) so it's easy to see an update has landed.
// Cloudflare's build sets WORKERS_CI_COMMIT_SHA; locally we ask git.
function commit() {
  try {
    return (process.env.WORKERS_CI_COMMIT_SHA || execSync('git rev-parse HEAD').toString()).trim().slice(0, 7);
  } catch {
    return 'lokal';
  }
}

export default defineConfig({
  root: 'web',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(commit()),
    __APP_BUILT__: JSON.stringify(new Date().toISOString()),
  },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: { root: '.', include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'web/src/**/*.test.ts'] },
} as any);
