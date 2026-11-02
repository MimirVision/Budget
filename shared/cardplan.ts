/**
 * Betalingsplan for a credit card, worked out from its bills (see server/cardledger.ts):
 * - payToStayFree: "nothing should cost interest up to this date: how much do we pay, and by when?"
 * - whatIfPay: "if we pay this much now, what does it cover, and what's the next deadline?"
 *
 * A bill is interest-free only when all of it is paid by its due date, so it's always whole bills. Payments go
 * to the oldest bill first, as the banks do it.
 */

export interface PlanPeriod {
  label: string;
  closes: string;
  due: string;
  left: number;
  status: 'open' | 'paid' | 'due' | 'overdue';
}

export interface PlanStep {
  label: string;
  due: string;
  amount: number;
  /** Past its due date: interest is already running. Pay as soon as possible. */
  overdue: boolean;
  /** The billing period is still running: new purchases before it closes are added to this amount. */
  open: boolean;
  closes: string;
}

export function payToStayFree(periods: PlanPeriod[], until: string, today: string) {
  const unpaid = periods.filter((p) => p.left > 0).sort((a, b) => a.due.localeCompare(b.due) || a.closes.localeCompare(b.closes));
  const steps: PlanStep[] = unpaid
    .filter((p) => p.due <= until)
    .map((p) => ({ label: p.label, due: p.due, amount: p.left, overdue: p.due < today, open: p.status === 'open', closes: p.closes }));
  const later = unpaid.find((p) => p.due > until) ?? null;
  return {
    until,
    total: steps.reduce((s, x) => s + x.amount, 0),
    steps,
    /** The first deadline among them: paying the whole total by then is the simplest. */
    payBy: steps[0]?.due ?? null,
    /** Some of it is still growing with new purchases. */
    growing: steps.some((s) => s.open),
    /** The next deadline after the chosen date, so it's clear what comes after. */
    later: later ? { label: later.label, due: later.due, amount: later.left, open: later.status === 'open' } : null,
  };
}

export function whatIfPay(periods: PlanPeriod[], amount: number, today: string) {
  let rest = Math.max(0, Math.round(amount));
  const bills = periods
    .filter((p) => p.left > 0)
    .sort((a, b) => a.closes.localeCompare(b.closes))
    .map((p) => {
      const take = Math.min(rest, p.left);
      rest -= take;
      return { label: p.label, due: p.due, closes: p.closes, open: p.status === 'open', paid: take, left: p.left - take, overdue: p.due < today };
    });
  const next = bills.find((b) => b.left > 0) ?? null;
  return {
    bills,
    /** Paid in full by this payment. */
    cleared: bills.filter((b) => b.left === 0 && b.paid > 0),
    /** The first bill still not fully paid: it must be paid by its due date to avoid interest. */
    next: next ? { label: next.label, due: next.due, left: next.left, overdue: next.overdue, open: next.open } : null,
    /** More than everything owed: left on the card. */
    extra: rest,
  };
}
