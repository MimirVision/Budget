import { describe, expect, it } from 'vitest';
import { all, get, run, setSetting } from './db.ts';
import { openDb } from './db-node.ts';
import { autoApprove, ingest } from './ingest.ts';

function setup() {
  const db = openDb(':memory:');
  const acc = Number(run(db, "INSERT INTO accounts(name, kind, on_budget) VALUES ('Brukskonto', 'checking', 1)").lastInsertRowid);
  const cat = (n: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', n)!.id;
  let n = 0;
  const add = (date: string, amount: number, description: string, account = acc) =>
    ingest(db, account, [{ date, amount, description, externalId: `x${++n}` }], 'enablebanking');
  const row = (id: number) => get<{ category_id: number | null; reviewed: number; auto_approved: number }>(db, 'SELECT category_id, reviewed, auto_approved FROM transactions WHERE id = ?', id)!;
  /** What you do in Gjennomgå: pick the category and approve. */
  const approve = (id: number, categoryId: number) => run(db, 'UPDATE transactions SET category_id = ?, reviewed = 1 WHERE id = ?', categoryId, id);
  return { db, acc, cat, add, row, approve };
}

describe('Godkjenn automatisk', () => {
  it('asks about the first one from a payee, then handles the rest on its own', () => {
    const { cat, add, row, approve } = setup();
    const first = add('2026-11-02', -45000, 'Joker Gulset').ids[0];
    expect(row(first)).toMatchObject({ reviewed: 0, category_id: null });
    approve(first, cat('Dagligvarer'));
    const next = add('2026-11-05', -38000, 'Joker Gulset');
    expect(next.autoApproved).toBe(1);
    expect(row(next.ids[0])).toEqual({ category_id: cat('Dagligvarer'), reviewed: 1, auto_approved: 1 });
  });

  it('always trusts a payee with a fixed category', () => {
    const { db, cat, add, row } = setup();
    run(db, "INSERT INTO rules(match_type, pattern, category_id) VALUES ('equals', 'Tesla Inc., OSLO', ?)", cat('Transport og drivstoff'));
    const r = add('2026-11-03', -22200, 'Tesla Inc., OSLO');
    expect(row(r.ids[0])).toMatchObject({ category_id: cat('Transport og drivstoff'), reviewed: 1, auto_approved: 1 });
  });

  it('asks when the payee has been in different categories, or the amount is far above the usual', () => {
    const { cat, add, row, approve } = setup();
    // Normal purchases at Clas Ohlson: sometimes Hus og apotek, sometimes Klær.
    approve(add('2026-10-01', -20000, 'Clas Ohlson Skien').ids[0], cat('Hus og apotek'));
    approve(add('2026-10-08', -25000, 'Clas Ohlson Skien').ids[0], cat('Klær'));
    expect(row(add('2026-11-01', -21000, 'Clas Ohlson Skien').ids[0]).reviewed).toBe(0);

    // A café that's usually 60 kr, now 4 000 kr.
    approve(add('2026-10-02', -6000, 'Kaffebrenneriet').ids[0], cat('Spise ute'));
    approve(add('2026-10-09', -6500, 'Kaffebrenneriet').ids[0], cat('Spise ute'));
    expect(row(add('2026-11-02', -400000, 'Kaffebrenneriet').ids[0]).reviewed).toBe(0);
    expect(row(add('2026-11-03', -7000, 'Kaffebrenneriet').ids[0]).reviewed).toBe(1);
  });

  it('leaves possible transfers for you', () => {
    const { db, cat, add, row, approve } = setup();
    const sparing = Number(run(db, "INSERT INTO accounts(name, kind, on_budget) VALUES ('Sparekonto', 'savings', 1)").lastInsertRowid);
    approve(add('2026-10-01', -100000, 'Til sparing').ids[0], cat('Buffer'));
    add('2026-11-01', 100000, 'Fra brukskonto', sparing);
    const out = add('2026-11-01', -100000, 'Til sparing').ids[0];
    expect(row(out).reviewed).toBe(0);
  });

  it('clears the ones waiting from a payee once you have categorised one, and can be turned off', () => {
    const { db, cat, add, row, approve } = setup();
    const a = add('2026-11-01', -30000, 'Bunnpris Gulset').ids[0];
    const b = add('2026-11-04', -32000, 'Bunnpris Gulset').ids[0];
    expect([row(a).reviewed, row(b).reviewed]).toEqual([0, 0]);
    approve(a, cat('Dagligvarer'));
    // What happens after you approve one in Gjennomgå: the waiting one gets the suggestion, then follows.
    run(db, "UPDATE transactions SET suggested_category_id = ?, suggestion_source = 'history' WHERE id = ?", cat('Dagligvarer'), b);
    expect(autoApprove(db, { payee: 'Bunnpris' })).toBe(1);
    expect(row(b)).toMatchObject({ category_id: cat('Dagligvarer'), reviewed: 1 });

    setSetting(db, 'auto_approve', 'off');
    expect(row(add('2026-11-06', -31000, 'Bunnpris Gulset').ids[0]).reviewed).toBe(0);
    expect(all(db, 'SELECT id FROM transactions WHERE reviewed = 0').length).toBe(1);
  });

  it('asks about a payment that names one of your own accounts, since it is most likely a transfer', () => {
    const { db, cat, add, row, approve } = setup();
    run(db, "INSERT INTO accounts(name, kind, on_budget) VALUES ('DNB MC', 'credit', 1)");
    approve(add('2026-10-14', -3000000, 'DNB MC').ids[0], cat('Dagligvarer'));
    expect(row(add('2026-11-14', -3546300, 'DNB MC').ids[0]).reviewed).toBe(0);
  });
});
