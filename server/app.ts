import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { DB } from './db.ts';
import { createApi, type AppConfig } from './api.ts';
import { hmacHex, safeEqual } from './webcrypto.ts';

/** The whole API with the optional household password in front. Shared by the Node server and the Cloudflare Worker. */
export function createApp(db: DB, config: AppConfig) {
  const app = new Hono();
  const password = config.password;
  const token = password ? hmacHex(password, 'budget-session') : Promise.resolve('');
  const loggedIn = async (c: any) => !password || safeEqual(getCookie(c, 'budget_session') ?? '', await token);

  app.post('/api/auth/login', async (c) => {
    const { password: given } = await c.req.json().catch(() => ({ password: '' }));
    if (!password) return c.json({ ok: true });
    if (!safeEqual(String(given ?? ''), password)) return c.json({ error: 'Feil passord' }, 401);
    setCookie(c, 'budget_session', await token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: c.req.url.startsWith('https'),
      path: '/',
      maxAge: 60 * 60 * 24 * 90,
    });
    return c.json({ ok: true });
  });

  app.get('/api/auth/status', async (c) => c.json({ required: !!password, loggedIn: await loggedIn(c) }));

  app.use('/api/*', async (c, next) => {
    if (!(await loggedIn(c))) return c.json({ error: 'Du må logge inn' }, 401);
    await next();
  });

  app.route('/api', createApi(db, config));
  return app;
}
