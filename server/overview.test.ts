import { describe, expect, it } from 'vitest';
import { get, run, setSetting } from './db.ts';
import { openDb } from './db-node.ts';
import { linkTransfer } from './ingest.ts';
import { overview } from './overview.ts';

describe('overview', () => {
  it('sums spending by category against the previous month, leaving out transfers and the opening balance', () => {
    const db = openDb(':memory:');
    const cat = (n: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', n)!.id;
    const a = Number(run(db, "INSERT INTO accounts(name) VALUES ('SB1')").lastInsertRowid);
    const b = Number(run(db, "INSERT INTO accounts(name, kind) VALUES ('Revolut', 'checking')").lastInsertRowid);
    const tx = (acc: number, date: string, amount: number, payee: string, c: string | null) =>
      Number(run(db, 'INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed) VALUES (?, ?, ?, ?, ?, 1)', acc, date, amount, payee, c ? cat(c) : null).lastInsertRowid);
    tx(a, '2026-09-01', 1_000_000, 'Startsaldo', 'Annen inntekt');
    tx(a, '2026-09-20', 4_000_000, 'Lønn', 'Lønn');
    tx(a, '2026-09-10', -50_000, 'Rema 1000', 'Dagligvarer');
    tx(a, '2026-10-20', 4_000_000, 'Lønn', 'Lønn');
    tx(a, '2026-10-02', -30_000, 'Rema 1000', 'Dagligvarer');
    tx(b, '2026-10-05', -20_000, 'Rema 1000', 'Dagligvarer');
    tx(b, '2026-10-06', -15_000, 'Wolt', 'Spise ute');
    tx(b, '2026-10-07', 5_000, 'Wolt', 'Spise ute'); // refund
    tx(a, '2026-10-25', 3_000_000, 'Lønn ikke gjennomgått', null); // uncategorised money in is not "negative spending"
    linkTransfer(db, tx(a, '2026-10-03', -100_000, 'Revolut', null), tx(b, '2026-10-03', 100_000, 'Påfyll', null));

    const o = overview(db, '2026-10', 1);
    expect(o.income).toBe(4_000_000);
    expect(o.spending).toBe(60_000);
    expect(o.prevSpending).toBe(50_000);
    expect(o.prevIncome).toBe(4_000_000); // opening balance is not income
    const everyday = o.groups.find((g) => g.name === 'Hverdag')!;
    expect(everyday.categories.map((c) => [c.name, c.spent, c.prevSpent])).toEqual([
      ['Dagligvarer', 50_000, 50_000],
      ['Spise ute', 10_000, 0],
    ]);
    expect(o.payees[0]).toMatchObject({ payee: 'Rema 1000', spent: 50_000, count: 2 });
    expect(o.largest[0]).toMatchObject({ payee: 'Rema 1000', amount: -30_000 });
    expect(o.daily).toHaveLength(31);
    expect(o.daily[6].cum).toBe(60_000);
    expect(overview(db, '2026-10', 3).months.map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('keeps showing history from before a fresh start, and says so', () => {
    const db = openDb(':memory:');
    const cat = get<{ id: number }>(db, "SELECT id FROM categories WHERE name = 'Dagligvarer'")!.id;
    const a = Number(run(db, "INSERT INTO accounts(name) VALUES ('SB1')").lastInsertRowid);
    run(db, "INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed) VALUES (?, '2026-09-10', -40000, 'Rema 1000', ?, 1)", a, cat);
    setSetting(db, 'budget_start', '2026-11-01');
    const sept = overview(db, '2026-09', 1);
    expect(sept.spending).toBe(40_000);
    expect(sept.historyBefore).toBe('2026-11-01');
    expect(overview(db, '2026-12', 1).historyBefore).toBeNull();
  });

  it('splits fixed bills from everyday spending, per account and weekday', () => {
    const db = openDb(':memory:');
    const cat = (n: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', n)!.id;
    const a = Number(run(db, "INSERT INTO accounts(name) VALUES ('SB1')").lastInsertRowid);
    const b = Number(run(db, "INSERT INTO accounts(name) VALUES ('Revolut')").lastInsertRowid);
    const tx = (acc: number, date: string, amount: number, payee: string, c: string) =>
      run(db, 'INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed) VALUES (?, ?, ?, ?, ?, 1)', acc, date, amount, payee, cat(c));
    tx(a, '2026-09-01', -1_480_000, 'SpareBank 1 Boliglån', 'Boliglån'); // a Tuesday
    tx(b, '2026-09-04', -50_000, 'Rema 1000', 'Dagligvarer'); // a Friday
    tx(b, '2026-09-04', -20_000, 'Kiwi', 'Dagligvarer');
    const o = overview(db, '2026-09', 1);
    expect(o.fixedSpending).toBe(1_480_000);
    expect(o.payees.map((p) => p.payee)).toEqual(['Rema 1000', 'Kiwi']); // the mortgage isn't shopping
    expect(o.largest.every((t) => t.payee !== 'SpareBank 1 Boliglån')).toBe(true);
    expect(o.accounts.map((x) => [x.name, x.spent])).toEqual([['SB1', 1_480_000], ['Revolut', 70_000]]);
    expect(o.weekdays[4].total).toBe(70_000); // Friday
    expect(o.calendar.find((d) => d.date === '2026-09-04')?.spent).toBe(70_000);
    expect(o.stats).toMatchObject({ days: 30, noSpendDays: 29, purchases: 2 });
    expect(o.groups.find((g) => g.name === 'Faste utgifter')?.fixed).toBe(true);
  });
});
