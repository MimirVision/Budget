import { describe, expect, it } from 'vitest';
import { run } from './db.ts';
import { openDb } from './db-node.ts';
import { cardAlerts, cardOverview, matchBalance, saveStatement } from './cards.ts';

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

  it('uses the bill entered from the bank, and does not count the opening balance as new purchases', () => {
    const { db, tx, card } = setup();
    tx('2026-11-01', -530200, 'Startsaldo'); // "Start på nytt": all the debt as one line on the start date
    tx('2026-11-01', -20000, 'Rema');
    run(db, "INSERT INTO settings(key, value) VALUES ('budget_start', '2026-11-01')");
    // Without the bill: the opening balance is the bill before the start, due 20.11, not "nye kjøp".
    let [c] = cardOverview(db, '2026-11-02');
    expect(c.breakdown).toMatchObject({ nextBill: 530200, unbilled: 20000 });
    expect(c.purchases.find((p) => p.kind === 'opening')).toMatchObject({ due: '2026-11-20', bill: 'oktober-regningen' });

    saveStatement(db, card, { closed: '2026-10-31', due: '2026-11-20', amount: 480000, minimum: 50000 }, '2026-11-02');
    [c] = cardOverview(db, '2026-11-02');
    expect(c.statement).toMatchObject({ closed: '2026-10-31', due: '2026-11-20', amount: 480000, left: 480000, status: 'due', minimum: 50000, fromBank: true });
    expect(c.owed).toBe(500000);
    expect(c.bank).toMatchObject({ newer: false, appOwed: 550200 });
    expect(c.breakdown).toMatchObject({ overdue: 0, nextBill: 480000, unbilled: 20000 });
    expect(c.purchases.map((p) => [p.payee, p.left, p.due, p.daysLeft, p.kind])).toEqual([
      ['Regningen fra banken', 480000, '2026-11-20', 18, 'unknown'],
      ['Rema', 20000, '2026-12-20', 48, 'purchase'],
    ]);

    // Kontoer can be made to match; the card page stays the same.
    expect(matchBalance(db, card, '2026-11-02')).toBe(50200);
    [c] = cardOverview(db, '2026-11-02');
    expect(c.bank.appOwed).toBe(500000);
    expect(c.owed).toBe(500000);
  });

  it('shows the purchases the app has on the entered bill, and the rest as one line', () => {
    const { db, tx, card } = setup();
    tx('2026-10-05', -100000, 'Elkjøp');
    tx('2026-10-25', -50000, 'Kiwi');
    saveStatement(db, card, { closed: '2026-10-31', due: '2026-11-20', amount: 300000 }, '2026-11-02');
    tx('2026-11-10', 200000, 'Innbetaling');
    const [c] = cardOverview(db, '2026-11-12');
    const by = Object.fromEntries(c.purchases.map((p) => [p.payee, p]));
    // The unknown 1 500 is the oldest (older debt), so the payment covers it first, then Elkjøp.
    expect(by['Eldre saldo og ukjente kjøp']).toMatchObject({ amount: 150000, left: 0, status: 'paid' });
    expect(by.Elkjøp).toMatchObject({ left: 50000, status: 'free' });
    expect(by.Kiwi).toMatchObject({ left: 50000, status: 'free' });
    expect(c.statement).toMatchObject({ amount: 300000, paid: 200000, left: 100000, status: 'due' });

    // A smaller bill than the purchases: the older ones were already paid before it.
    saveStatement(db, card, { closed: '2026-10-31', due: '2026-11-20', amount: 120000 }, '2026-11-02');
    const [d] = cardOverview(db, '2026-11-02');
    expect(d.purchases.filter((p) => p.left > 0).map((p) => [p.payee, p.left])).toEqual([
      ['Elkjøp', 70000],
      ['Kiwi', 50000],
    ]);
  });

  it('fills in from the bank balance what the app has not seen since the bill', () => {
    const { db, tx, card } = setup();
    tx('2026-11-03', -20000, 'Rema');
    saveStatement(db, card, { closed: '2026-10-31', due: '2026-11-20', amount: 300000, balance: 350000, balance_date: '2026-11-05' }, '2026-11-05');
    let [c] = cardOverview(db, '2026-11-06');
    expect(c.owed).toBe(350000);
    expect(c.breakdown).toMatchObject({ nextBill: 300000, unbilled: 50000 });
    expect(c.purchases.find((p) => p.id === -2)).toMatchObject({ amount: 30000, due: '2026-12-20', kind: 'unknown' });

    // Less than the app thinks: a payment the app hasn't seen, which went to the bill.
    saveStatement(db, card, { closed: '2026-10-31', due: '2026-11-20', amount: 300000, balance: 250000, balance_date: '2026-11-05' }, '2026-11-05');
    [c] = cardOverview(db, '2026-11-06');
    expect(c.owed).toBe(250000);
    expect(c.statement).toMatchObject({ left: 230000, paid: 70000 });
  });

  it('takes a bill entered on its statement day as closed, and notices when a newer bill has come', () => {
    const { db, card } = setup({ due_day: null as any });
    run(db, 'UPDATE accounts SET due_day = NULL, statement_day = NULL WHERE id = ?', card);
    saveStatement(db, card, { closed: '2026-10-31', due: '2026-11-18', amount: 100000 }, '2026-10-31');
    let [c] = cardOverview(db, '2026-10-31');
    expect(c.statement).toMatchObject({ closed: '2026-10-31', due: '2026-11-18', status: 'due' });
    expect(c.current).toMatchObject({ from: '2026-11-01', closes: '2026-11-30', due: '2026-12-18' }); // due day from the bill
    [c] = cardOverview(db, '2026-12-02');
    expect(c.bank.newer).toBe(true);
  });

  it('refuses a bill that does not make sense', () => {
    const { db, card } = setup();
    expect(() => saveStatement(db, card, { closed: '2026-12-01', due: '2026-12-20', amount: 1 }, '2026-11-02')).toThrow(/frem i tid/);
    expect(() => saveStatement(db, card, { closed: '2026-10-31', due: '2026-10-20', amount: 1 }, '2026-11-02')).toThrow(/etter fakturadatoen/);
    expect(() => saveStatement(db, card, { closed: '2026-10-31', due: '2026-11-20', amount: 100, minimum: 200 }, '2026-11-02')).toThrow(/Minstebeløpet/);
  });

  it('uses the balance from a CSV or sync, with or without an entered bill', () => {
    const { db, tx, card } = setup();
    tx('2026-10-05', -100000, 'Elkjøp');
    tx('2026-11-03', -20000, 'Rema');
    // The CSV said 1 700 owed on 4.11; the app only explains 1 200: 500 of older debt goes on the last closed bill.
    run(db, "UPDATE accounts SET bank_balance = -170000, bank_balance_at = '2026-11-04 23:59:59' WHERE id = ?", card);
    let [c] = cardOverview(db, '2026-11-05');
    expect(c.owed).toBe(170000);
    expect(c.bank.balance).toEqual({ owed: 170000, date: '2026-11-04', source: 'csv' });
    expect(c.breakdown).toMatchObject({ nextBill: 150000, unbilled: 20000 });
    expect(c.purchases.find((p) => p.id === -2)).toMatchObject({ amount: 50000, due: '2026-11-20' });

    // Kontoer can be matched without a bill, and nothing is counted twice afterwards.
    expect(matchBalance(db, card, '2026-11-05')).toBe(-50000);
    [c] = cardOverview(db, '2026-11-05');
    expect(c.owed).toBe(170000);
    expect(c.bank.appOwed).toBe(170000);

    // With a bill, a newer bank balance fills in after it; an older one is left out.
    saveStatement(db, card, { closed: '2026-10-31', due: '2026-11-20', amount: 160000 }, '2026-11-05');
    [c] = cardOverview(db, '2026-11-05');
    // Bill 1 600 + Rema 200 would be 1 800, but the bank said 1 700: a payment of 100 the app hasn't seen.
    expect(c.owed).toBe(170000);
    expect(c.breakdown).toMatchObject({ nextBill: 150000, unbilled: 20000 });
    run(db, "UPDATE accounts SET bank_balance_at = '2026-10-20 10:00:00' WHERE id = ?", card);
    [c] = cardOverview(db, '2026-11-05');
    expect(c.bank.balance).toBeNull();
  });
});
