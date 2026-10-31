import { describe, expect, it } from 'vitest';
import { get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { payday, syncHealth } from './insights.ts';

function setup() {
  const db = openDb(':memory:');
  const acc = Number(run(db, "INSERT INTO accounts(name) VALUES ('Revolut')").lastInsertRowid);
  const conn = Number(run(db, "INSERT INTO connections(provider, name, status, data, last_sync_at) VALUES ('enablebanking', 'Revolut', 'active', '{}', '2026-10-31 08:00:00')").lastInsertRowid);
  run(db, "INSERT INTO connection_accounts(connection_id, remote_id, remote_name, account_id) VALUES (?, 'r1', 'Revolut', ?)", conn, acc);
  return { db, acc };
}

describe('sync health', () => {
  it('flags a bank that went quiet compared with its usual pace', () => {
    const { db, acc } = setup();
    for (let d = 1; d <= 20; d++)
      run(db, "INSERT INTO transactions(account_id, date, amount, source) VALUES (?, ?, -100, 'enablebanking')", acc, `2026-10-${String(d).padStart(2, '0')}`);
    const now = Date.parse('2026-10-31T09:00:00Z');
    expect(syncHealth(db, '2026-10-31', now)).toMatchObject([{ name: 'Revolut', kind: 'quiet', days: 11, usual: 1 }]);
    expect(syncHealth(db, '2026-10-22', Date.parse('2026-10-22T09:00:00Z')).length).toBe(0);
  });

  it('flags a sync that has not run for over a day', () => {
    const { db } = setup();
    expect(syncHealth(db, '2026-11-02', Date.parse('2026-11-02T12:00:00Z'))).toMatchObject([{ kind: 'nosync' }]);
  });
});

describe('payday', () => {
  it('finds the salary from the last few days, even before it is reviewed', () => {
    const { db, acc } = setup();
    const lonn = get<{ id: number }>(db, "SELECT id FROM categories WHERE name = 'Lønn'")!.id;
    run(db, "INSERT INTO transactions(account_id, date, amount, payee) VALUES (?, '2026-10-20', 4350000, 'Arbeidsgiver AS')", acc);
    run(db, "UPDATE transactions SET suggested_category_id = ? WHERE payee = 'Arbeidsgiver AS'", lonn);
    run(db, "INSERT INTO transactions(account_id, date, amount, payee) VALUES (?, '2026-10-21', 900000, 'Fra Nikita')", acc);
    expect(payday(db, '2026-10-22')).toMatchObject({ payee: 'Arbeidsgiver AS', amount: 4350000, reviewed: 0 });
    expect(payday(db, '2026-10-30')).toBeNull();
  });
});
