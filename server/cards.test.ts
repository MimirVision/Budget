import { describe, expect, it } from 'vitest';
import { run } from './db.ts';
import { openDb } from './db-node.ts';
import { cardAlerts, cardOverview } from './cards.ts';

function setup(terms: Record<string, number | null> = {}) {
  const db = openDb(':memory:');
  const card = Number(
    run(
      db,
      `INSERT INTO accounts(name, kind, on_budget, statement_day, due_day, interest_rate, credit_limit, min_pay_pct, min_pay_kr)
       VALUES ('DNB Mastercard', 'credit', 0, ?, ?, ?, ?, ?, ?)`,
      terms.statement_day ?? 31,
      terms.due_day ?? 20,
      terms.interest_rate ?? 2290,
      terms.credit_limit ?? 5000000,
      terms.min_pay_pct ?? 300,
      terms.min_pay_kr ?? 30000,
    ).lastInsertRowid,
  );
  const tx = (date: string, amount: number, payee: string) => run(db, 'INSERT INTO transactions(account_id, date, amount, payee) VALUES (?, ?, ?, ?)', card, date, amount, payee);
  return { db, card, tx };
}

describe('Kredittkort', () => {
  it('works out the bill, the due date and what is left to pay', () => {
    const { db, tx } = setup();
    tx('2026-10-05', -400000, 'Elkjøp');
    tx('2026-10-20', -100000, 'Kiwi');
    tx('2026-11-03', -50000, 'Rema'); // the new period
    tx('2026-11-10', 200000, 'Innbetaling');
    const [c] = cardOverview(db, '2026-11-12');
    expect(c.statement).toMatchObject({ closed: '2026-10-31', due: '2026-11-20', amount: 500000, paid: 200000, left: 300000, status: 'due', minimum: 30000 });
    expect(c.current).toMatchObject({ from: '2026-11-01', closes: '2026-11-30', spent: 50000, due: '2026-12-20' });
    expect(c.owed).toBe(350000);
    expect(c.available).toBe(5000000 - 350000);
    expect(c.freeToday).toEqual({ days: 38, until: '2026-12-20' });
    expect(c.freeMax).toBe(49);
    expect(c.bestBuyDay).toBe(1);
    expect(cardAlerts(db, '2026-11-17')).toMatchObject([{ status: 'due', left: 300000, days: 3 }]);
    expect(cardAlerts(db, '2026-11-25')).toMatchObject([{ status: 'overdue' }]);
  });

  it('shows what paying only the minimum costs', () => {
    const { db, tx } = setup();
    tx('2026-10-05', -2000000, 'Ferie');
    const [c] = cardOverview(db, '2026-11-02');
    expect(c.interestPerMonth).toBe(Math.round((2000000 * 0.229) / 12));
    expect(c.minimumOnly!.months).toBeGreaterThan(40);
    expect(c.minimumOnly!.interest).toBeGreaterThan(500000);
  });

  it('uses "interest-free days" when there is no due day, and finds fees and cash withdrawals', () => {
    const { db, tx, card } = setup();
    run(db, 'UPDATE accounts SET due_day = NULL, free_days = 50 WHERE id = ?', card);
    tx('2026-10-05', -9500, 'Fakturagebyr');
    tx('2026-10-07', -150000, 'Kontantuttak Minibank');
    const [c] = cardOverview(db, '2026-11-02');
    expect(c.statement.due).toBe('2026-11-19'); // 30.09 + 50 days
    expect(c.feesThisYear.total).toBe(9500);
    expect(c.cashThisYear).toEqual({ total: 150000, count: 1 });
  });

  it('is paid when payments cover the bill', () => {
    const { db, tx } = setup();
    tx('2026-10-05', -100000, 'Kiwi');
    tx('2026-11-15', 100000, 'Innbetaling');
    expect(cardOverview(db, '2026-11-16')[0].statement.status).toBe('paid');
    expect(cardAlerts(db, '2026-11-16')).toEqual([]);
  });
});
