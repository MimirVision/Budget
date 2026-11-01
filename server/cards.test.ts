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

  it('pays down the oldest bill first and says what each payment covered', () => {
    const { db, tx } = setup();
    tx('2026-09-10', -300000, 'Elkjøp'); // september bill: 3 000
    tx('2026-10-10', -200000, 'Kiwi'); // october bill: 2 000
    tx('2026-11-03', -100000, 'Rema'); // not billed yet: 1 000
    tx('2026-10-15', 350000, 'Innbetaling'); // all of september + 500 of october
    tx('2026-11-12', 200000, 'Innbetaling'); // rest of october + 500 of the new purchases
    const [c] = cardOverview(db, '2026-11-14');
    expect(c.payments.map((p) => p.covered)).toEqual([
      [
        { label: 'oktober-regningen', amount: 150000 },
        { label: 'nye kjøp (ikke fakturert ennå)', amount: 50000 },
      ],
      [
        { label: 'september-regningen', amount: 300000 },
        { label: 'oktober-regningen', amount: 50000 },
      ],
    ]);
    expect(c.periods.map((p) => [p.label, p.charged, p.left, p.status])).toEqual([
      ['november-regningen', 100000, 50000, 'open'],
      ['oktober-regningen', 200000, 0, 'paid'],
      ['september-regningen', 300000, 0, 'paid'],
    ]);
    expect(c.breakdown).toMatchObject({ overdue: 0, nextBill: 0, unbilled: 50000, credit: 0 });
    expect(c.statement.status).toBe('paid');
    expect(c.owed).toBe(50000);
  });

  it('splits what is owed into overdue, next bill and not billed yet, with interest on the overdue part', () => {
    const { db, tx } = setup();
    tx('2026-09-10', -300000, 'Elkjøp');
    tx('2026-10-10', -200000, 'Kiwi');
    tx('2026-11-03', -100000, 'Rema');
    tx('2026-10-15', 100000, 'Innbetaling'); // only part of september
    const [c] = cardOverview(db, '2026-11-14');
    expect(c.breakdown).toMatchObject({ overdue: 200000, nextBill: 200000, unbilled: 100000, credit: 0 });
    expect(c.breakdown.accruedInterest).toBeGreaterThan(0);
    expect(c.statement).toMatchObject({ status: 'overdue', left: 400000 });
  });

  it('keeps an overpayment as money on the card', () => {
    const { db, tx } = setup();
    tx('2026-10-10', -100000, 'Kiwi');
    tx('2026-11-05', 150000, 'Innbetaling');
    const [c] = cardOverview(db, '2026-11-06');
    expect(c.breakdown.credit).toBe(50000);
    expect(c.payments[0]).toMatchObject({ extra: 50000 });
    expect(c.owed).toBe(0);
  });

  it('shows each purchase with its interest-free days left, paying the oldest purchases first', () => {
    const { db, tx } = setup();
    tx('2026-10-05', -100000, 'Elkjøp');
    tx('2026-10-25', -50000, 'Kiwi');
    tx('2026-11-04', -20000, 'Rema');
    tx('2026-11-08', 120000, 'Innbetaling'); // all of Elkjøp, 200 of Kiwi
    const [c] = cardOverview(db, '2026-11-10');
    const by = Object.fromEntries(c.purchases.map((p) => [p.payee, p]));
    expect(by.Elkjøp).toMatchObject({ status: 'paid', left: 0 });
    expect(by.Kiwi).toMatchObject({ status: 'free', left: 30000, due: '2026-11-20', daysLeft: 10, freeDays: 26, billed: true });
    expect(by.Rema).toMatchObject({ status: 'free', left: 20000, due: '2026-12-20', daysLeft: 40, billed: false });
    expect(c.purchases.map((p) => p.payee)).toEqual(['Kiwi', 'Rema', 'Elkjøp']); // most urgent first, paid last
    expect(by.Kiwi.interest).toBeGreaterThan(0); // what being a month late would cost

    const [late] = cardOverview(db, '2026-11-25');
    expect(late.purchases[0]).toMatchObject({ payee: 'Kiwi', status: 'overdue', daysLeft: -5 });
  });
});
