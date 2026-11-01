/**
 * Kredittkort: the bill, the interest-free days and what it costs if you don't pay it all, from the card's terms
 * (statement day, due day, interest rate, minimum payment, limit) and its transactions.
 *
 * Norwegian cards work like this: purchases are collected over a billing period that closes on a fixed day
 * (fakturadato). The bill for that period is due some days later (forfall). Pay it all by then and there's no
 * interest; otherwise interest is charged, usually from the purchase date.
 */
import { all, get, type DB } from './db.ts';
import { budgetStart, getBudget } from './budget.ts';
import { addDays, addMonths, dayDiff, daysInMonth, todayISO } from '../shared/months.ts';

export interface CardTerms {
  statement_day: number | null;
  due_day: number | null;
  interest_rate: number | null; // hundredths of a percent a year
  credit_limit: number | null; // øre
  free_days: number | null;
  min_pay_pct: number | null; // hundredths of a percent
  min_pay_kr: number | null; // øre
}

export interface CardOverview extends CardTerms {
  id: number;
  name: string;
  on_budget: number;
  /** Terms filled in? Without them some numbers are estimates. */
  configured: boolean;
  owed: number;
  available: number | null;
  /** The last closed billing period and its bill. */
  statement: { closed: string; due: string; amount: number; paid: number; left: number; status: 'paid' | 'due' | 'overdue' | 'none'; minimum: number | null; dueIsEstimate: boolean };
  /** The period running now. */
  current: { from: string; closes: string; spent: number; due: string };
  /** Bought today: interest-free until… */
  freeToday: { days: number; until: string };
  /** The longest interest-free time, for a purchase right after the statement day. */
  freeMax: number;
  bestBuyDay: number;
  /** Paying only the minimum on what's owed now, with no new purchases. */
  minimumOnly: { monthly: number; months: number | null; interest: number } | null;
  /** Interest per month on what's owed now, if it isn't paid in full. */
  interestPerMonth: number | null;
  /** This year: interest and fees charged, and cash withdrawals (which cost interest from day one). */
  feesThisYear: { total: number; items: Array<{ date: string; payee: string; amount: number }> };
  cashThisYear: { total: number; count: number };
  /** Set aside in the Kortregning pot (cards on the budget). */
  pot: number | null;
}

const clampDay = (month: string, day: number) => `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`;

/** The day a billing period closes in a given month. Month end when the statement day isn't set. */
function closeIn(month: string, statementDay: number | null) {
  return clampDay(month, statementDay ?? 31);
}

/** The most recent close on or before `date`'s previous day, and the next one after. */
function closesAround(date: string, statementDay: number | null) {
  const month = date.slice(0, 7);
  const thisClose = closeIn(month, statementDay);
  // The period closes at the end of its close day, so on that day it's still open.
  const last = date > thisClose ? thisClose : closeIn(addMonths(month, -1), statementDay);
  const next = date > thisClose ? closeIn(addMonths(month, 1), statementDay) : thisClose;
  return { last, next, before: (close: string) => closeIn(addMonths(close.slice(0, 7), -1), statementDay) };
}

/** When the bill for the period closing on `close` is due. */
function dueFor(close: string, prevClose: string, t: CardTerms): { due: string; estimate: boolean } {
  if (t.due_day) {
    const sameMonth = clampDay(close.slice(0, 7), t.due_day);
    return { due: sameMonth > close ? sameMonth : clampDay(addMonths(close.slice(0, 7), 1), t.due_day), estimate: false };
  }
  // "Up to N interest-free days" counts from the first day of the period.
  if (t.free_days) return { due: addDays(prevClose, t.free_days), estimate: false };
  return { due: addDays(close, 20), estimate: true };
}

const FEE = /\b(rente|renter|gebyr|årsavgift|termingebyr|fakturagebyr|purregebyr|purring|omkostning)/i;
const CASH = /\b(kontantuttak|minibank|atm|cash|uttak)\b/i;

export function cardOverview(db: DB, today = todayISO()): CardOverview[] {
  const start = budgetStart(db);
  const cards = all<CardTerms & { id: number; name: string; on_budget: number }>(
    db,
    `SELECT id, name, on_budget, statement_day, due_day, interest_rate, credit_limit, free_days, min_pay_pct, min_pay_kr
       FROM accounts WHERE kind = 'credit' AND closed = 0 ORDER BY sort, id`,
  );
  let potRows: Array<{ id: number; available: number }> | null = null;
  return cards.map((c) => {
    const owedAt = (date: string) =>
      -(get<{ s: number }>(db, 'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND date >= ? AND date <= ?', c.id, start, date)!.s);
    const owed = Math.max(0, owedAt(today));

    const { last, next, before } = closesAround(today, c.statement_day);
    const prev = before(last);
    const lastDue = dueFor(last, prev, c);
    const nextDue = dueFor(next, last, c);

    const billed = Math.max(0, owedAt(last));
    const paid = get<{ s: number }>(db, 'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND amount > 0 AND date > ? AND date <= ?', c.id, last, today)!.s;
    const left = Math.max(0, billed - paid);
    const status: CardOverview['statement']['status'] = billed <= 0 ? 'none' : left <= 0 ? 'paid' : today > lastDue.due ? 'overdue' : 'due';

    const pct = c.min_pay_pct ?? 300; // 3 % is common in Norway, but the card's own terms win
    const minKr = c.min_pay_kr ?? 30000;
    const minimum = billed > 0 ? Math.min(billed, Math.max(minKr, Math.round((billed * pct) / 10000))) : null;

    const spent = -(get<{ s: number }>(db, 'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND amount < 0 AND date > ? AND date <= ?', c.id, last, today)!.s);

    // Interest-free time: from the purchase to the due date of the period it lands in.
    const freeToday = { days: dayDiff(today, nextDue.due), until: nextDue.due };
    const freeMax = dayDiff(addDays(last, 1), nextDue.due);
    const bestBuyDay = Number(addDays(last, 1).slice(8, 10));

    let minimumOnly: CardOverview['minimumOnly'] = null;
    let interestPerMonth: number | null = null;
    if (c.interest_rate && owed > 0) {
      const r = c.interest_rate / 10000 / 12;
      interestPerMonth = Math.round(owed * r);
      let b = owed;
      let months = 0;
      let interest = 0;
      while (b > 0 && months < 600) {
        const i = b * r;
        const pay = Math.min(b + i, Math.max(minKr, (b * pct) / 10000));
        if (pay <= i) {
          months = -1;
          break;
        }
        interest += i;
        b = b + i - pay;
        months++;
      }
      minimumOnly = { monthly: Math.max(minKr, Math.round((owed * pct) / 10000)), months: months < 0 || months >= 600 ? null : months, interest: Math.round(interest) };
    }

    const yearStart = `${today.slice(0, 4)}-01-01`;
    const rows = all<{ date: string; payee: string; raw_description: string; amount: number }>(
      db,
      'SELECT date, payee, raw_description, amount FROM transactions WHERE account_id = ? AND amount < 0 AND date >= ? ORDER BY date DESC',
      c.id,
      yearStart,
    );
    const fees = rows.filter((r) => FEE.test(`${r.payee} ${r.raw_description}`));
    const cash = rows.filter((r) => CASH.test(`${r.payee} ${r.raw_description}`));

    const pot = get<{ id: number }>(db, 'SELECT id FROM categories WHERE card_account_id = ?', c.id);
    // The budget is worked out once for all cards, and only if a card has a pot.
    if (pot && c.on_budget && !potRows) potRows = getBudget(db, today.slice(0, 7)).groups.flatMap((g) => g.categories);
    const potAvailable = pot && c.on_budget ? potRows?.find((r) => r.id === pot.id)?.available ?? 0 : null;

    return {
      ...c,
      configured: !!(c.interest_rate && (c.due_day || c.free_days)),
      owed,
      available: c.credit_limit ? c.credit_limit - owed : null,
      statement: { closed: last, due: lastDue.due, amount: billed, paid: Math.min(paid, billed), left, status, minimum, dueIsEstimate: lastDue.estimate },
      current: { from: addDays(last, 1), closes: next, spent, due: nextDue.due },
      freeToday,
      freeMax,
      bestBuyDay,
      minimumOnly,
      interestPerMonth,
      feesThisYear: { total: fees.reduce((s, r) => s - r.amount, 0), items: fees.slice(0, 5).map((r) => ({ date: r.date, payee: r.payee || r.raw_description, amount: -r.amount })) },
      cashThisYear: { total: cash.reduce((s, r) => s - r.amount, 0), count: cash.length },
      pot: potAvailable,
    };
  });
}

/** Reminders for the Budsjett page: a bill due within five days, or one that wasn't paid in full. */
export function cardAlerts(db: DB, today = todayISO()) {
  return cardOverview(db, today)
    .filter((c) => (c.statement.status === 'due' && dayDiff(today, c.statement.due) <= 5) || c.statement.status === 'overdue')
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.statement.status as 'due' | 'overdue',
      left: c.statement.left,
      due: c.statement.due,
      days: dayDiff(today, c.statement.due),
      interestPerMonth: c.interestPerMonth,
      pot: c.pot,
    }));
}
