import { describe, expect, it } from 'vitest';
import { all, get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { getBudget, readyToAssign, setAssigned } from './budget.ts';
import { applyFreshStart, followBankAfterFreshStart, previewFreshStart, undoFreshStart } from './freshstart.ts';
import { overview } from './overview.ts';

function setup() {
  const db = openDb(':memory:');
  const cat = (n: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', n)!.id;
  const sb1 = Number(run(db, "INSERT INTO accounts(name, bank_balance) VALUES ('SB1', 2500000)").lastInsertRowid);
  const tf = Number(run(db, "INSERT INTO accounts(name, kind) VALUES ('TF Bank', 'credit')").lastInsertRowid);
  const add = (acc: number, date: string, amount: number, c: string | null, reviewed = 1) =>
    run(db, 'INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed) VALUES (?, ?, ?, ?, ?, ?)', acc, date, amount, 'x', c ? cat(c) : null, reviewed);
  // October: messy history (transfers counted as income, a forgotten unreviewed one, budgets set)
  add(sb1, '2026-10-05', 900_000, 'Lønn');
  add(sb1, '2026-10-06', 300_000, 'Annen inntekt'); // really a transfer
  add(sb1, '2026-10-10', -200_000, 'Dagligvarer');
  add(sb1, '2026-10-12', -50_000, null, 0);
  setAssigned(db, '2026-10', cat('Dagligvarer'), 400_000);
  // November so far
  add(sb1, '2026-11-02', -10_000, 'Dagligvarer');
  return { db, cat, sb1, tf };
}

describe('fresh start', () => {
  it('starts each account from the bank balance on the start date, with nothing carried over', () => {
    const { db, cat, sb1, tf } = setup();
    const preview = previewFreshStart(db, '2026-11-01');
    // Bank says 25 000 today; 100 kr has been spent since 1 Nov, so it had 25 100 on the start date.
    expect(preview.find((p) => p.accountId === sb1)).toMatchObject({ source: 'bank', opening: 2_510_000 });
    expect(preview.find((p) => p.accountId === tf)).toMatchObject({ source: 'history', opening: 0 });

    applyFreshStart(db, '2026-11-01', { [tf]: -320_000 }); // TF card typed in: 3 200 kr owed
    expect(readyToAssign(db)).toBe(2_510_000 - 320_000);
    const nov = getBudget(db, '2026-11');
    const groceries = nov.groups.flatMap((g) => g.categories).find((c) => c.id === cat('Dagligvarer'))!;
    expect(groceries.available).toBe(-10_000); // October's 2 000 kr leftover is gone
    expect(nov.income).toBe(0); // the opening balance is money you had, not income
    expect(nov.unreviewed).toBe(0); // October's unreviewed transaction isn't asked about any more
    expect(overview(db, '2026-11', 1).income).toBe(0); // opening balance isn't income
    expect(overview(db, '2026-10', 1).spending).toBe(0); // before the start nothing counts
  });

  it('keeps following the bank right after the start, unless the balance was typed in', () => {
    const { db, sb1 } = setup();
    applyFreshStart(db, '2026-11-01');
    run(db, 'UPDATE accounts SET bank_balance = 2400000 WHERE id = ?', sb1); // a late October booking
    followBankAfterFreshStart(db, sb1, '2026-11-03');
    const opening = get<{ amount: number }>(db, "SELECT amount FROM transactions WHERE source = 'freshstart' AND account_id = ?", sb1)!.amount;
    expect(opening).toBe(2_410_000);
  });

  it('can be undone', () => {
    const { db } = setup();
    const before = readyToAssign(db);
    applyFreshStart(db, '2026-11-01');
    undoFreshStart(db);
    expect(readyToAssign(db)).toBe(before);
    expect(all(db, "SELECT 1 FROM transactions WHERE source = 'freshstart'")).toHaveLength(0);
  });
});
