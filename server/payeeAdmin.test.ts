import { describe, expect, it } from 'vitest';
import { all, get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { ingest } from './ingest.ts';
import { listPayees, renamePayee, setPayeeCategory } from './payeeAdmin.ts';

function setup() {
  const db = openDb(':memory:');
  const acc = Number(run(db, "INSERT INTO accounts(name, kind, on_budget) VALUES ('DNB MC', 'credit', 1)").lastInsertRowid);
  const cat = (n: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', n)!.id;
  return { db, acc, cat };
}

describe('Mottakere', () => {
  it('gives every transaction from a payee its category, and the next ones too', () => {
    const { db, acc, cat } = setup();
    ingest(
      db,
      acc,
      [
        { date: '2026-10-17', amount: -27359, description: 'Tesla Inc., OSLO', externalId: 'a' },
        { date: '2026-10-27', amount: -11815, description: 'Tesla Inc., OSLO', externalId: 'b' },
        { date: '2026-10-30', amount: -23215, description: 'Tesla Inc., OSLO', externalId: 'c' },
      ],
      'csv',
    );
    const payee = get<{ payee: string }>(db, 'SELECT payee FROM transactions LIMIT 1')!.payee;
    const r = setPayeeCategory(db, payee, cat('Transport og drivstoff'));
    expect(r.changed).toBe(3);
    expect(all(db, 'SELECT DISTINCT category_id, reviewed FROM transactions')).toEqual([{ category_id: cat('Transport og drivstoff'), reviewed: 1 }]);
    // A new one from the bank gets it straight away.
    ingest(db, acc, [{ date: '2026-11-02', amount: -18100, description: 'Tesla Inc., OSLO', externalId: 'd' }], 'csv');
    expect(get(db, "SELECT suggested_category_id, suggestion_source FROM transactions WHERE external_id = 'd'")).toEqual({
      suggested_category_id: cat('Transport og drivstoff'),
      suggestion_source: 'rule',
    });
    const [row] = listPayees(db);
    expect(row).toMatchObject({ payee, count: 4, spent: 27359 + 11815 + 23215 + 18100, category_id: cat('Transport og drivstoff') });
    // Undo data: what each one had before.
    expect(r.before.map((b) => b.category_id)).toEqual([null, null, null]);
  });

  it('renames a payee everywhere and for new imports, and merges into an existing name', () => {
    const { db, acc, cat } = setup();
    ingest(db, acc, [{ date: '2026-10-05', amount: -228512, description: 'Tesla Inc., OSLO', externalId: 'a' }], 'csv');
    ingest(db, acc, [{ date: '2026-10-06', amount: -50848, description: 'TESLA NORWAY AS', externalId: 'b' }], 'csv');
    const names = all<{ payee: string }>(db, 'SELECT payee FROM transactions ORDER BY id').map((r) => r.payee);
    expect(new Set(names).size).toBe(2);
    setPayeeCategory(db, names[0], cat('Transport og drivstoff'));
    renamePayee(db, names[0], 'Tesla');
    renamePayee(db, names[1], 'Tesla'); // merge
    expect(all(db, 'SELECT DISTINCT payee FROM transactions')).toEqual([{ payee: 'Tesla' }]);
    const tesla = listPayees(db).find((p) => p.payee === 'Tesla')!;
    expect(tesla).toMatchObject({ count: 2, category_id: cat('Transport og drivstoff') });
    expect(tesla.aliases.sort()).toEqual([names[0], names[1]].sort());
    // The bank's old name comes in again: it's called Tesla and gets the category.
    ingest(db, acc, [{ date: '2026-11-03', amount: -12000, description: 'TESLA NORWAY AS', externalId: 'c' }], 'csv');
    expect(get(db, "SELECT payee, suggested_category_id FROM transactions WHERE external_id = 'c'")).toEqual({
      payee: 'Tesla',
      suggested_category_id: cat('Transport og drivstoff'),
    });
  });
});
