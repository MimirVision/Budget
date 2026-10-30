import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { getSetting, setSetting, type DB } from './db.ts';
import { createApi, type AppConfig } from './api.ts';
import { hmacHex, safeEqual } from './webcrypto.ts';

/** The whole API with the optional household password in front. Shared by the Node server and the Cloudflare Worker. */
export function createApp(db: DB, config: AppConfig) {
  const app = new Hono();
  const password = config.password;
  const token = password ? hmacHex(password, 'budget-session') : Promise.resolve('');
  const loggedIn = async (c: any) => !password || safeEqual(getCookie(c, 'budget_session') ?? '', await token);

  // The app is on the open internet: after a few wrong passwords, stop answering for a while so it can't be guessed.
  const MAX_TRIES = 5;
  const LOCK_MINUTES = 15;
  app.post('/api/auth/login', async (c) => {
    const { password: given } = await c.req.json().catch(() => ({ password: '' }));
    if (!password) return c.json({ ok: true });
    const lockedUntil = getSetting(db, 'login_locked_until');
    if (lockedUntil && Date.parse(lockedUntil) > Date.now()) {
      const minutes = Math.ceil((Date.parse(lockedUntil) - Date.now()) / 60_000);
      return c.json({ error: `For mange feil forsøk. Prøv igjen om ${minutes} min.` }, 429);
    }
    if (!safeEqual(String(given ?? ''), password)) {
      const failures = Number(getSetting(db, 'login_failures') ?? 0) + 1;
      if (failures >= MAX_TRIES) {
        setSetting(db, 'login_locked_until', new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString());
        setSetting(db, 'login_failures', null);
        return c.json({ error: `For mange feil forsøk. Prøv igjen om ${LOCK_MINUTES} min.` }, 429);
      }
      setSetting(db, 'login_failures', String(failures));
      return c.json({ error: `Feil passord (${MAX_TRIES - failures} forsøk igjen)` }, 401);
    }
    setSetting(db, 'login_failures', null);
    setSetting(db, 'login_locked_until', null);
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
