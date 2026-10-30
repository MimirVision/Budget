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
