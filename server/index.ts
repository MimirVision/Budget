/** Running on your own machine or server with Node. On Cloudflare, server/worker.ts is used instead. */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db-node.ts';
import { createApp } from './app.ts';
import { syncAll } from './sync/index.ts';

try {
  process.loadEnvFile?.('.env');
} catch {
  // No .env file; that's fine.
}

const db = openDb(path.join(process.env.DATA_DIR ?? './data', 'budget.db'));
const app = createApp(db, { password: process.env.APP_PASSWORD, publicUrl: process.env.PUBLIC_URL });

// Production: serve the built web app.
if (fs.existsSync('dist/index.html')) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Budsjett kjører på http://localhost:${port}`));

// Bank sync: shortly after start, then every few hours.
if (process.env.SYNC_DISABLED !== '1') {
  const tick = () =>
    syncAll(db)
      .then((r) => r.length && console.log(`[sync] ${r.map((x) => `${x.name}: ${x.error ?? `+${x.added}`}`).join(', ')}`))
      .catch((e) => console.error('[sync] failed', e));
  setTimeout(tick, 60_000);
  setInterval(tick, Number(process.env.SYNC_EVERY_HOURS ?? 4) * 3_600_000).unref();
}
