import { describe, expect, it } from 'vitest';
import { all, get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { forgetImport, ingest, transferToAccount } from './ingest.ts';
import { findDuplicates, mergeDuplicates } from './duplicates.ts';
import { addDays, todayISO } from '../shared/months.ts';

const d = (n: number) => addDays(todayISO(), -n);

function setup() {
  const db = openDb(':memory:');
  const acc = (name: string) => Number(run(db, 'INSERT INTO accounts(name) VALUES (?)', name).lastInsertRowid);
  return { db, sb1: acc('SB1'), revolut: acc('Revolut') };
}
const count = (db: any, account: number) => get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?', account)!.n;

describe('duplicates: causes', () => {
  it('updates in place when the bank changes the id of a purchase', () => {
    const { db, sb1 } = setup();
    const since = d(10);
    ingest(db, sb1, [{ externalId: 'tmp-1', date: d(3), amount: -8990, description: 'VISA Rema 1000' }], 'enablebanking', { since });
    ingest(db, sb1, [{ externalId: 'final-1', date: d(2), amount: -8990, description: 'Rema 1000 Grimstad' }], 'enablebanking', { since });
    expect(all<any>(db, 'SELECT external_id, date FROM transactions')).toEqual([{ external_id: 'final-1', date: d(2) }]);
  });

  it('keeps two real purchases that the bank still lists', () => {
    const { db, sb1 } = setup();
    const since = d(10);
    const a = { externalId: 'a', date: d(3), amount: -4500, description: 'Kaffe' };
    ingest(db, sb1, [a], 'enablebanking', { since });
    ingest(db, sb1, [a, { externalId: 'b', date: d(2), amount: -4500, description: 'Kaffe' }], 'enablebanking', { since });
    expect(count(db, sb1)).toBe(2);
  });

  it('does not bring back a transaction you deleted', () => {
    const { db, sb1 } = setup();
    const t = { externalId: 'x', date: d(2), amount: -1000, description: 'Kiosk' };
    const [id] = ingest(db, sb1, [t], 'sparebank1').ids;
    forgetImport(db, id);
    run(db, 'DELETE FROM transactions WHERE id = ?', id);
    ingest(db, sb1, [t], 'sparebank1');
    expect(count(db, sb1)).toBe(0);
  });

  it('matches a CSV row to a synced one a few days apart', () => {
    const { db, sb1 } = setup();
    ingest(db, sb1, [{ externalId: 's', date: d(5), amount: -29900, description: 'Elkjøp' }], 'sparebank1');
    ingest(db, sb1, [{ importHash: 'h', date: d(8), amount: -29900, description: 'ELKJØP GRIMSTAD' }], 'csv');
    expect(count(db, sb1)).toBe(1);
  });
});

describe('duplicates: finder', () => {
  it('explains why and merges, moving the category over', () => {
    const { db, sb1, revolut } = setup();
    const cat = get<{ id: number }>(db, "SELECT id FROM categories WHERE name = 'Dagligvarer'")!.id;
    // Old data from before the fixes: the same purchase from the bank twice with different ids.
    run(db, "INSERT INTO transactions(account_id, date, amount, payee, raw_description, source, external_id, category_id, reviewed) VALUES (?, ?, -8990, 'Rema', 'VISA REMA', 'enablebanking', 'p1', ?, 1)", sb1, d(4), cat);
    run(db, "INSERT INTO transactions(account_id, date, amount, payee, raw_description, source, external_id) VALUES (?, ?, -8990, 'Rema', 'Rema 1000', 'enablebanking', 'p2')", sb1, d(3));
    // A transfer copy the app made, then the bank's own row.
    const out = Number(run(db, "INSERT INTO transactions(account_id, date, amount, source, external_id) VALUES (?, ?, -50000, 'sparebank1', 'o')", sb1, d(6)).lastInsertRowid);
    transferToAccount(db, out, revolut);
    run(db, "INSERT INTO transactions(account_id, date, amount, source, external_id) VALUES (?, ?, 50000, 'enablebanking', 'r')", revolut, d(5));

    const { groups } = findDuplicates(db);
    expect(groups.map((g) => g.reason).sort()).toEqual(['bank_changed_id', 'transfer_copy']);
    const rema = groups.find((g) => g.reason === 'bank_changed_id')!;
    const other = rema.rows.find((r) => r.id !== rema.keep)!;
    mergeDuplicates(db, other.id, [rema.keep]); // keep the uncategorised one: the category should follow
    expect(get<any>(db, 'SELECT category_id, reviewed FROM transactions WHERE id = ?', other.id)).toEqual({ category_id: cat, reviewed: 1 });

    const transfer = findDuplicates(db).groups[0];
    mergeDuplicates(db, transfer.keep, transfer.rows.map((r) => r.id));
    const kept = get<any>(db, 'SELECT transfer_id FROM transactions WHERE account_id = ?', revolut);
    expect(kept.transfer_id).toBe(out);
    expect(findDuplicates(db).groups).toHaveLength(0);
  });

  it('spots one account fed by two bank connections', () => {
    const { db, sb1 } = setup();
    run(db, "INSERT INTO transactions(account_id, date, amount, source, external_id) VALUES (?, ?, -89900, 'sparebank1', 'a')", sb1, d(4));
    run(db, "INSERT INTO transactions(account_id, date, amount, source, external_id) VALUES (?, ?, -89900, 'enablebanking', 'b')", sb1, d(2));
    expect(findDuplicates(db).groups[0]).toMatchObject({ reason: 'two_bank_routes', confidence: 'sure' });
  });
});
