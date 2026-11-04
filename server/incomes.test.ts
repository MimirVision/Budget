import { describe, expect, it } from 'vitest';
import { run } from './db.ts';
import { openDb } from './db-node.ts';
import { addIncome, incomeOutlook, incomesFor } from './incomes.ts';

function setup() {
  const db = openDb(':memory:');
  const acc = Number(run(db, "INSERT INTO accounts(name, kind, on_budget) VALUES ('Brukskonto', 'checking', 1)").lastInsertRowid);
  const tx = (date: string, amount: number, payee: string) => run(db, 'INSERT INTO transactions(account_id, date, amount, payee, raw_description) VALUES (?, ?, ?, ?, ?)', acc, date, amount, payee, payee);
  return { db, tx };
}

describe('Forventet inntekt', () => {
  it('marks pay as received when a matching payment comes in, a few days early included', () => {
    const { db, tx } = setup();
    addIncome(db, { name: 'Lønn Andreas', amount: 4350000, day: 25, match: 'Agder Kommune' });
    addIncome(db, { name: 'Lønn Nikita', amount: 3100000, day: 20, match: '' });
    tx('2026-11-23', 4352310, 'Lønn Agder Kommune'); // two days early, a little more than expected
    let [a, n] = incomesFor(db, '2026-11', '2026-11-24');
    expect(a).toMatchObject({ expected: '2026-11-25', status: 'received', received: { amount: 4352310 } });
    expect(n).toMatchObject({ expected: '2026-11-20', status: 'late', received: null });
    // Without a text to match, a payment near the expected amount and date counts.
    tx('2026-11-24', 3080000, 'Overføring arbeidsgiver');
    [a, n] = incomesFor(db, '2026-11', '2026-11-24');
    expect(n).toMatchObject({ status: 'received', received: { amount: 3080000 } });
    // A small payment isn't mistaken for pay; three days after the expected date it counts as late.
    tx('2026-12-19', 50000, 'Vipps fra Kari');
    expect(incomesFor(db, '2026-12', '2026-12-21')[1]).toMatchObject({ status: 'waiting', received: null });
    expect(incomesFor(db, '2026-12', '2026-12-24')[1]).toMatchObject({ status: 'late', received: null });
  });

  it('adds what is still to come, from this month up to the month being planned', () => {
    const { db, tx } = setup();
    addIncome(db, { name: 'Lønn', amount: 4000000, day: 31, match: 'Lønn' });
    const nov = incomeOutlook(db, '2026-11', '2026-11-04');
    expect(nov).toMatchObject({ expected: 4000000, received: 0, pending: 4000000, next: { date: '2026-11-30' } });
    // Planning December counts on both November's and December's pay.
    expect(incomeOutlook(db, '2026-12', '2026-11-04').pending).toBe(8000000);
    tx('2026-11-30', 4000000, 'Lønn');
    expect(incomeOutlook(db, '2026-11', '2026-11-30')).toMatchObject({ received: 4000000, pending: 0 });
    // A short month: the 31st becomes the last day.
    expect(incomesFor(db, '2027-02', '2027-01-10')[0].expected).toBe('2027-02-28');
    // Past months add nothing to what's still to come.
    expect(incomeOutlook(db, '2026-10', '2026-11-04').pending).toBe(0);
  });
});
