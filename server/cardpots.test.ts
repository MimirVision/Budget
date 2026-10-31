import { describe, expect, it } from 'vitest';
import { get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { getBudget, readyToAssign, setAssigned } from './budget.ts';
import { linkTransfer } from './ingest.ts';

const row = (db: any, month: string, name: string) => getBudget(db, month).groups.flatMap((g) => g.categories).find((c) => c.name === name)!;

describe('Kortregning (credit card payment pots)', () => {
  it('moves card spending into the pot, and paying the card takes it out again', () => {
    const db = openDb(':memory:');
    const sb1 = Number(run(db, "INSERT INTO accounts(name) VALUES ('SB1')").lastInsertRowid);
    const card = Number(run(db, "INSERT INTO accounts(name, kind, due_day) VALUES ('DNB Mastercard', 'credit', 20)").lastInsertRowid);
    const cat = (n: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', n)!.id;
    run(db, 'INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed) VALUES (?, ?, ?, ?, ?, 1)', sb1, '2026-11-01', 3_000_000, 'Lønn', cat('Lønn'));
    getBudget(db, '2026-11'); // creates the pot
    setAssigned(db, '2026-11', cat('Dagligvarer'), 100_000);
    const rta = readyToAssign(db);

    run(db, 'INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed) VALUES (?, ?, ?, ?, ?, 1)', card, '2026-11-05', -50_000, 'Rema', cat('Dagligvarer'));
    expect(row(db, '2026-11', 'Dagligvarer').available).toBe(50_000);
    const pot = row(db, '2026-11', 'Kortregning DNB Mastercard');
    expect(pot).toMatchObject({ available: 50_000, needed: 0, card: { owed: 50_000, dueDay: 20 } });
    expect(readyToAssign(db)).toBe(rta); // spending on the card doesn't touch Klar til fordeling

    const out = Number(run(db, "INSERT INTO transactions(account_id, date, amount, payee) VALUES (?, '2026-11-20', -50000, 'DNB')", sb1).lastInsertRowid);
    const inn = Number(run(db, "INSERT INTO transactions(account_id, date, amount, payee) VALUES (?, '2026-11-20', 50000, 'Innbetaling')", card).lastInsertRowid);
    linkTransfer(db, out, inn);
    expect(row(db, '2026-11', 'Kortregning DNB Mastercard')).toMatchObject({ available: 0, needed: 0, card: { owed: 0 } });
    expect(readyToAssign(db)).toBe(rta);
  });

  it('shows what is missing when the card has debt the budget has not covered', () => {
    const db = openDb(':memory:');
    const card = Number(run(db, "INSERT INTO accounts(name, kind) VALUES ('TF Bank', 'credit')").lastInsertRowid);
    const income = get<{ id: number }>(db, "SELECT id FROM categories WHERE name = 'Annen inntekt'")!.id;
    // Opening debt at a fresh start is booked against income, so it isn't counted as already set aside.
    run(db, "INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed, source) VALUES (?, '2026-11-01', -320000, 'Startsaldo', ?, 1, 'freshstart')", card, income);
    expect(row(db, '2026-11', 'Kortregning TF Bank')).toMatchObject({ available: 0, needed: 320_000 });
  });

  it('hides the pot when the card is taken off the budget', () => {
    const db = openDb(':memory:');
    const card = Number(run(db, "INSERT INTO accounts(name, kind) VALUES ('DNB', 'credit')").lastInsertRowid);
    expect(row(db, '2026-11', 'Kortregning DNB').hidden).toBe(0);
    run(db, 'UPDATE accounts SET on_budget = 0 WHERE id = ?', card);
    expect(row(db, '2026-11', 'Kortregning DNB').hidden).toBe(1);
  });
});
