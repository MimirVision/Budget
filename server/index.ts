import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie } from 'hono/cookie';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.ts';
import { createApi } from './api.ts';
import { startScheduler } from './sync/index.ts';

try {
  process.loadEnvFile?.('.env');
} catch {
  // No .env file; that's fine.
}

const dataDir = process.env.DATA_DIR ?? './data';
const db = openDb(path.join(dataDir, 'budget.db'));
const app = new Hono();

// Optional shared household password. Leave APP_PASSWORD empty when running only on your own machine.
const password = process.env.APP_PASSWORD;
const sessionToken = password ? crypto.createHmac('sha256', password).update('budget-session').digest('hex') : '';

app.post('/api/auth/login', async (c) => {
  const { password: given } = await c.req.json().catch(() => ({ password: '' }));
  if (!password) return c.json({ ok: true });
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(password);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return c.json({ error: 'Wrong password' }, 401);
  setCookie(c, 'budget_session', sessionToken, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: c.req.url.startsWith('https'),
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  });
  return c.json({ ok: true });
});

app.get('/api/auth/status', (c) =>
  c.json({ required: !!password, loggedIn: !password || getCookie(c, 'budget_session') === sessionToken }),
);

app.use('/api/*', async (c, next) => {
  if (password && getCookie(c, 'budget_session') !== sessionToken) return c.json({ error: 'Please log in' }, 401);
  await next();
});

app.route('/api', createApi(db));

// Production: serve the built web app.
if (fs.existsSync('dist/index.html')) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Budget is running on http://localhost:${port}`));

if (process.env.SYNC_DISABLED !== '1') startScheduler(db, Number(process.env.SYNC_EVERY_HOURS ?? 4));
