import { describe, expect, it } from 'vitest';
import { get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { createApp } from './app.ts';

function setup() {
  const db = openDb(':memory:');
  const app = createApp(db, { password: '', publicUrl: 'http://localhost' });
  const acc = Number(run(db, "INSERT INTO accounts(name) VALUES ('SB1')").lastInsertRowid);
  const txn = Number(
    run(db, "INSERT INTO transactions(account_id, date, amount, payee, reviewed) VALUES (?, '2026-10-02', -30000, 'Elkjøp', 1)", acc)
      .lastInsertRowid,
  );
  return { db, app, txn };
}

describe('attachments', () => {
  it('stores a receipt, serves the same bytes back and counts it on the transaction', async () => {
    const { app, txn } = setup();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 255, 128, 7]);
    const up = await app.request(`/api/transactions/${txn}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('kvittering æøå.pdf') },
      body: bytes,
    });
    expect(up.status).toBe(200);
    const a = await up.json();
    expect(a).toMatchObject({ name: 'kvittering æøå.pdf', mime: 'application/pdf', size: 8 });

    const back = await app.request(`/api/attachments/${a.id}`);
    expect(back.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);

    const { transactions } = await (await app.request('/api/transactions?limit=5')).json();
    expect(transactions.find((x: any) => x.id === txn).attachment_count).toBe(1);

    await app.request(`/api/attachments/${a.id}`, { method: 'DELETE' });
    expect((await app.request(`/api/attachments/${a.id}`)).status).toBe(404);
  });

  it('refuses other file types', async () => {
    const { app, txn } = setup();
    const res = await app.request(`/api/transactions/${txn}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: '<script>alert(1)</script>',
    });
    expect(res.status).toBe(400);
  });
});

describe('wrap-up', () => {
  it('summarises a finished month', async () => {
    const { app, db } = setup();
    const id = get<{ id: number }>(db, "SELECT id FROM categories WHERE name = 'Dagligvarer'")!.id;
    run(db, 'UPDATE transactions SET category_id = ?', id);
    const res = await app.request('/api/wrapup?month=2026-10');
    expect(res.status).toBe(200);
    const w = await res.json();
    expect(w.month).toBe('2026-10');
    expect(w.spending).toBe(30000);
    expect(w.top[0]).toMatchObject({ name: 'Dagligvarer', spent: 30000 });
    expect(w.overspent).toEqual([{ id, name: 'Dagligvarer', amount: 30000 }]);
  });
});

describe('login', () => {
  it('locks out after five wrong passwords', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, { password: 'riktig', publicUrl: 'http://localhost' });
    const login = (password: string) =>
      app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    for (let i = 0; i < 4; i++) expect((await login('feil')).status).toBe(401);
    expect((await login('feil')).status).toBe(429);
    expect((await login('riktig')).status).toBe(429); // even the right one waits
    run(db, "DELETE FROM settings WHERE key = 'login_locked_until'");
    const ok = await login('riktig');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('budget_session=');
  });
});

describe('bulk edit', () => {
  it('sets a category on many, skips transfers, and deletes', async () => {
    const { app, db, txn } = setup();
    const acc = get<{ id: number }>(db, 'SELECT id FROM accounts')!.id;
    const two = Number(run(db, "INSERT INTO transactions(account_id, date, amount, payee) VALUES (?, '2026-10-03', -5000, 'Kiwi')", acc).lastInsertRowid);
    const tr = Number(run(db, "INSERT INTO transactions(account_id, date, amount, payee, transfer_id) VALUES (?, '2026-10-04', -9000, 'Til sparing', 999)", acc).lastInsertRowid);
    const cat = get<{ id: number }>(db, "SELECT id FROM categories WHERE name = 'Dagligvarer'")!.id;
    const post = (body: unknown) =>
      app.request('/api/transactions/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await (await post({ ids: [txn, two, tr], action: 'category', category_id: cat })).json();
    expect(r).toEqual({ changed: 2, skipped: 1 });
    expect(get<any>(db, 'SELECT category_id, reviewed FROM transactions WHERE id = ?', two)).toEqual({ category_id: cat, reviewed: 1 });
    await post({ ids: [two], action: 'delete' });
    expect(get(db, 'SELECT id FROM transactions WHERE id = ?', two)).toBeUndefined();
  });
});

describe('category history', () => {
  it('gives spent and assigned per month', async () => {
    const { app, db } = setup();
    const cat = get<{ id: number }>(db, "SELECT id FROM categories WHERE name = 'Dagligvarer'")!.id;
    run(db, 'UPDATE transactions SET category_id = ?', cat);
    run(db, "INSERT INTO assignments(month, category_id, amount) VALUES ('2026-10', ?, 50000)", cat);
    const rows = await (await app.request(`/api/categories/${cat}/history?month=2026-10&months=3`)).json();
    expect(rows).toEqual([
      { month: '2026-08', spent: 0, assigned: 0 },
      { month: '2026-09', spent: 0, assigned: 0 },
      { month: '2026-10', spent: 30000, assigned: 50000 },
    ]);
  });
});

describe('assigning before a fresh start', () => {
  it('is refused, since it would not count', async () => {
    const { app, db } = setup();
    run(db, "INSERT INTO settings(key, value) VALUES ('budget_start', '2026-11-01')");
    const cat = get<{ id: number }>(db, "SELECT id FROM categories WHERE name = 'Dagligvarer'")!.id;
    const put = (month: string) =>
      app.request(`/api/budget/${month}/${cat}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 50000 }) });
    expect((await put('2026-10')).status).toBe(400);
    const ok = await put('2026-11');
    expect(ok.status).toBe(200);
    const b = await ok.json();
    expect(b.groups.flatMap((g: any) => g.categories).find((c: any) => c.id === cat).assigned).toBe(50000);
  });
});
