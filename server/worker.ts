/**
 * Cloudflare entry point (free plan friendly).
 * - The web app is served as static assets.
 * - /api/* goes to one Durable Object, "household", which holds all data in its built-in SQLite database.
 *   It runs the exact same code as the Node server, through the adapter in db-do.ts.
 * - A cron trigger syncs the banks every four hours.
 */
import { DurableObject } from 'cloudflare:workers';
import { durableObjectDb } from './db-do.ts';
import { initSchema, type DB } from './db.ts';
import { createApp } from './app.ts';
import { syncAll } from './sync/index.ts';

interface Env {
  BUDGET: DurableObjectNamespace<BudgetStore>;
  ASSETS: Fetcher;
  APP_PASSWORD?: string;
  PUBLIC_URL?: string;
}

export class BudgetStore extends DurableObject<Env> {
  private db: DB;
  private app: ReturnType<typeof createApp>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = durableObjectDb(ctx.storage);
    initSchema(this.db);
    this.app = createApp(this.db, { password: env.APP_PASSWORD, publicUrl: env.PUBLIC_URL });
  }

  fetch(request: Request) {
    return this.app.fetch(request);
  }

  async syncBanks() {
    const results = await syncAll(this.db);
    if (results.length) console.log(`[sync] ${results.map((r) => `${r.name}: ${r.error ?? `+${r.added}`}`).join(', ')}`);
    return results.length;
  }
}

const household = (env: Env) => env.BUDGET.get(env.BUDGET.idFromName('household'));

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return household(env).fetch(request);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(household(env).syncBanks());
  },
} satisfies ExportedHandler<Env>;
