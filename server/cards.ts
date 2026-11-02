/**
 * Kredittkort: the bill, the interest-free days and what it costs if you don't pay it all, from the card's terms
 * (statement day, due day, interest rate, minimum payment, limit) and its transactions.
 *
 * Norwegian cards work like this: purchases are collected over a billing period that closes on a fixed day
 * (fakturadato). The bill for that period is due some days later (forfall). Pay it all by then and there's no
 * interest; otherwise interest is charged, usually from the purchase date.
 */
import { all, get, run, type DB } from './db.ts';
import { budgetStart, getBudget } from './budget.ts';
import { addDays, dayDiff, todayISO } from '../shared/months.ts';
import {
  balanceCheck,
  closesAround,
  dueFor,
  type BalanceCheck,
  effectiveTerms,
  latestStatement,
  ledger,
  type CardStatement,
  type CardTerms,
  type Payment,
  type Period,
  type Purchase,
} from './cardledger.ts';

export type { CardStatement, CardTerms, Payment, Period, Purchase };

export interface CardOverview extends CardTerms {
  id: number;
  name: string;
  on_budget: number;
  /** Terms filled in? Without them some numbers are estimates. */
  configured: boolean;
  /** Dates the app had to guess: the statement day (month end assumed) and the due date (20 days later assumed). */
  guessed: { statementDay: boolean; due: boolean };
  owed: number;
  available: number | null;
  /** The last closed billing period and its bill. */
  statement: {
    closed: string;
    due: string;
    amount: number;
    paid: number;
    left: number;
    status: 'paid' | 'due' | 'overdue' | 'none';
    minimum: number | null;
    dueIsEstimate: boolean;
    /** The amount is the bank's, entered from the bill. */
    fromBank: boolean;
  };
  /** The bill entered from the bank, if any, and what the app's own balance says. */
  bank: { statement: CardStatement | null; newer: boolean; appOwed: number; balance: BalanceCheck | null };
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
  /** What's owed, split by how urgent it is. */
  breakdown: { overdue: number; nextBill: number; unbilled: number; credit: number; accruedInterest: number | null };
  /** Billing periods, newest first: charged, paid down, left. */
  periods: Period[];
  /** Payments (and refunds) into the card, newest first, with what each one paid down. */
  payments: Payment[];
  /** Every purchase from the last bill on, and any older one still unpaid, with how long each has before interest. */
  purchases: Purchase[];
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
  return cards.map((card) => {
    const bank = latestStatement(db, card.id);
    // The bank's own bill fills in what the terms don't say.
    const c = effectiveTerms(card, bank);
    // A bill entered on its statement day: that day already counts as closed.
    const ref = bank && bank.closed >= today ? addDays(bank.closed, 1) : today;
    const { last, next, before } = closesAround(ref, c.statement_day);
    const prev = before(last);
    const lastDue = bank && bank.closed === last ? { due: bank.due, estimate: false } : dueFor(last, prev, c);
    const nextDue = dueFor(next, last, c);

    const check = balanceCheck(db, card.id, bank);
    const book = ledger(db, c, start, today, bank, check);
    const owed = Math.max(0, book.owed);
    // What the app's own balance (Kontoer) says, to show when it doesn't match the bank.
    const appOwed = -(get<{ s: number }>(db, 'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND date >= ? AND date <= ?', c.id, start, today)!.s);

    // The last closed bill: what was on it, and how much of it (plus anything older) is still unpaid.
    const lastPeriod = book.periods.find((p) => p.closes === last);
    const billed = lastPeriod?.charged ?? 0;
    const left = book.breakdown.overdue + book.breakdown.nextBill;
    const paid = lastPeriod?.paid ?? 0;
    const status: CardOverview['statement']['status'] =
      book.breakdown.overdue > 0 ? 'overdue' : book.breakdown.nextBill > 0 ? 'due' : billed > 0 ? 'paid' : 'none';

    const pct = c.min_pay_pct ?? 300; // 3 % is common in Norway, but the card's own terms win
    const minKr = c.min_pay_kr ?? 30000;
    const minimum =
      bank && bank.closed === last && bank.minimum !== null
        ? bank.minimum
        : billed > 0
          ? Math.min(billed, Math.max(minKr, Math.round((billed * pct) / 10000)))
          : null;
    const spent = book.periods.find((p) => p.closes === next)?.charged ?? 0;

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

    const { owed: _owed, ...rest } = book;
    return {
      ...card, // the terms as saved (what the bill fills in is used above, not shown as if it were saved)
      configured: !!(c.interest_rate && (c.due_day || c.free_days)),
      guessed: { statementDay: !card.statement_day && !bank, due: !card.due_day && !card.free_days && !bank },
      owed,
      bank: {
        statement: bank,
        // A newer bill has closed since the one entered: worked out from transactions until it's entered too.
        newer: !!bank && last > bank.closed,
        appOwed,
        balance: check,
      },
      available: c.credit_limit ? c.credit_limit - owed : null,
      statement: { closed: last, due: lastPeriod?.due ?? lastDue.due, amount: billed, paid, left, status, minimum, dueIsEstimate: lastDue.estimate, fromBank: !!lastPeriod?.fromBank },
      current: { from: addDays(last, 1), closes: next, spent, due: nextDue.due },
      freeToday,
      freeMax,
      bestBuyDay,
      minimumOnly,
      interestPerMonth,
      feesThisYear: { total: fees.reduce((s, r) => s - r.amount, 0), items: fees.slice(0, 5).map((r) => ({ date: r.date, payee: r.payee || r.raw_description, amount: -r.amount })) },
      cashThisYear: { total: cash.reduce((s, r) => s - r.amount, 0), count: cash.length },
      pot: potAvailable,
      ...rest,
    };
  });
}

/** Reminders for the Budsjett page: a bill due within five days, or one that wasn't paid in full. */
export interface StatementInput {
  closed: string;
  due: string;
  amount: number;
  minimum?: number | null;
  balance?: number | null;
  balance_date?: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Saves the bill as the bank states it. It becomes the card's starting point. */
export function saveStatement(db: DB, accountId: number, input: StatementInput, today = todayISO()): number {
  const card = get<{ id: number }>(db, "SELECT id FROM accounts WHERE id = ? AND kind = 'credit'", accountId);
  if (!card) throw new Error('Fant ikke kortet');
  const { closed, due } = input;
  if (!ISO.test(String(closed)) || !ISO.test(String(due))) throw new Error('Velg fakturadato og forfallsdato');
  if (closed > today) throw new Error('Fakturadatoen kan ikke være frem i tid');
  if (due < closed) throw new Error('Forfall må være etter fakturadatoen');
  if (dayDiff(closed, due) > 70) throw new Error('Forfall er mer enn 70 dager etter fakturadatoen. Sjekk datoene');
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Skriv inn beløpet som skal betales');
  const minimum = input.minimum ? Math.max(0, Math.round(Number(input.minimum))) : null;
  if (minimum !== null && minimum > amount) throw new Error('Minstebeløpet kan ikke være større enn regningen');
  const hasBalance = input.balance !== null && input.balance !== undefined && String(input.balance) !== '';
  const balance = hasBalance ? Math.round(Number(input.balance)) : null;
  if (balance !== null && !Number.isFinite(balance)) throw new Error('Ugyldig saldo');
  const balanceDate = balance === null ? null : input.balance_date || today;
  if (balanceDate && (!ISO.test(balanceDate) || balanceDate < closed || balanceDate > today))
    throw new Error('Saldoen må være fra fakturadatoen eller senere, og ikke frem i tid');
  return Number(
    run(
      db,
      'INSERT INTO card_statements(account_id, closed, due, amount, minimum, balance, balance_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      accountId,
      closed,
      due,
      amount,
      minimum,
      balance,
      balanceDate,
    ).lastInsertRowid,
  );
}

/**
 * Makes the app's own balance for the card (Kontoer) match what the card page says is owed, with a
 * Saldojustering. The card page itself doesn't change: with a bill entered, adjustments are left out of it.
 */
export function matchBalance(db: DB, accountId: number, today = todayISO()): number {
  const c = cardOverview(db, today).find((x) => x.id === accountId);
  if (!c || (!c.bank.statement && !c.bank.balance)) throw new Error('Legg inn regningen eller saldoen fra banken først');
  const diff = c.bank.appOwed - c.owed;
  // Without an entered bill the adjustment is dated with the bank's balance, so it isn't counted twice.
  const date = !c.bank.statement && c.bank.balance ? c.bank.balance.date : today;
  if (diff !== 0)
    run(
      db,
      `INSERT INTO transactions(account_id, date, amount, payee, raw_description, reviewed, source)
       VALUES (?, ?, ?, 'Saldojustering', 'Saldojustering', 0, 'manual')`,
      accountId,
      date,
      diff,
    );
  return diff;
}

export function deleteStatement(db: DB, accountId: number, id: number) {
  run(db, 'DELETE FROM card_statements WHERE id = ? AND account_id = ?', id, accountId);
}

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
