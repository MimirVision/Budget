import { describe, expect, it } from 'vitest';
import { payToStayFree, whatIfPay, type PlanPeriod } from './cardplan.ts';

const periods: PlanPeriod[] = [
  { label: 'november-regningen', closes: '2026-11-30', due: '2026-12-20', left: 50000, status: 'open' },
  { label: 'oktober-regningen', closes: '2026-10-31', due: '2026-11-20', left: 300000, status: 'due' },
  { label: 'september-regningen', closes: '2026-09-30', due: '2026-10-20', left: 0, status: 'paid' },
];

describe('betalingsplan', () => {
  it('says what to pay so nothing costs interest up to a date', () => {
    expect(payToStayFree(periods, '2026-11-19', '2026-11-02')).toMatchObject({ total: 0, steps: [], later: { due: '2026-11-20', amount: 300000 } });
    const nov = payToStayFree(periods, '2026-11-20', '2026-11-02');
    expect(nov).toMatchObject({ total: 300000, payBy: '2026-11-20', growing: false, later: { label: 'november-regningen', open: true } });
    const dec = payToStayFree(periods, '2026-12-31', '2026-11-02');
    expect(dec.total).toBe(350000);
    expect(dec.steps.map((s) => [s.due, s.amount, s.open])).toEqual([
      ['2026-11-20', 300000, false],
      ['2026-12-20', 50000, true],
    ]);
    expect(dec.growing).toBe(true);
    expect(dec.later).toBeNull();
  });

  it('counts an overdue bill, which already costs interest', () => {
    const p = payToStayFree(periods, '2026-11-30', '2026-11-25');
    expect(p.steps[0]).toMatchObject({ overdue: true, amount: 300000 });
  });

  it('shows what a payment covers, oldest bill first', () => {
    const r = whatIfPay(periods, 320000, '2026-11-02');
    expect(r.cleared.map((b) => b.label)).toEqual(['oktober-regningen']);
    expect(r.next).toMatchObject({ label: 'november-regningen', due: '2026-12-20', left: 30000 });
    expect(r.extra).toBe(0);
    expect(whatIfPay(periods, 100000, '2026-11-02').next).toMatchObject({ label: 'oktober-regningen', left: 200000 });
    expect(whatIfPay(periods, 400000, '2026-11-02')).toMatchObject({ next: null, extra: 50000 });
  });
});
