/**
 * The credit card ledger: which bill each purchase lands on, when that bill must be paid to stay interest-free,
 * and what each payment paid down.
 *
 * Norwegian cards work like this: purchases are collected over a billing period that closes on a fixed day
 * (fakturadato). The bill for that period is due some days later (forfall). Pay all of it by then and there's no
 * interest; otherwise interest is charged on it, usually from the purchase date. Payments go to the oldest bill
 * first.
 *
 * The app rarely sees a card's whole history (TF Bank has no sync, and "Start på nytt" turns everything before
 * into one opening balance). So the bill as the bank states it ("å betale" and forfall) can be entered, and then
 * it is the starting point: that bill is exactly what the bank says, and only what happened after it is worked
 * out from transactions. With the balance from the bank as well, anything the app hasn't seen since the bill is
 * filled in too.
 */
import { all, get, type DB } from './db.ts';
import { addDays, addMonths, dayDiff, daysInMonth } from '../shared/months.ts';

export interface CardTerms {
  statement_day: number | null;
  due_day: number | null;
  interest_rate: number | null; // hundredths of a percent a year
  credit_limit: number | null; // øre
  free_days: number | null;
  min_pay_pct: number | null; // hundredths of a percent
  min_pay_kr: number | null; // øre
}

/** A bill as the bank states it. */
export interface CardStatement {
  id: number;
  account_id: number;
  closed: string;
  due: string;
  amount: number;
  minimum: number | null;
  balance: number | null;
  balance_date: string | null;
  created_at: string;
}

export interface Purchase {
  /** The transaction, or a negative id for an amount the app only knows from the bank's numbers. */
  id: number;
  date: string;
  payee: string;
  amount: number;
  /** Still unpaid of this purchase (payments go to the oldest bill first, and its oldest purchases first). */
  left: number;
  /** Must be paid by this date to stay interest-free: the due date of its bill. */
  due: string;
  /** Days from today to `due` (negative when past). */
  daysLeft: number;
  /** Interest-free days this purchase got in total (purchase date to due date). */
  freeDays: number;
  status: 'paid' | 'free' | 'overdue';
  /** Interest so far if overdue, or what one month late would cost if it isn't paid in time. */
  interest: number | null;
  billed: boolean;
  /** The bill it's on, and when that bill closes. */
  bill: string;
  closes: string;
  /** purchase: a transaction. unknown: from the bank's numbers, not a transaction the app has. opening: the
   *  balance the card had when the app started (not a purchase as such). */
  kind: 'purchase' | 'unknown' | 'opening';
}

export interface Period {
  from: string;
  closes: string;
  due: string;
  label: string;
  charged: number;
  paid: number;
  left: number;
  status: 'open' | 'paid' | 'due' | 'overdue';
  /** The amount is the bank's own (an entered bill), not worked out by the app. */
  fromBank: boolean;
}

export interface Payment {
  id: number;
  date: string;
  amount: number;
  kind: 'payment' | 'refund';
  text: string;
  covered: Array<{ label: string; amount: number }>;
  /** More than was owed: money left on the card. */
  extra: number;
}

const MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
export const UNBILLED_LABEL = 'nye kjøp (ikke fakturert ennå)';
const isOpening = (r: { payee: string }) => r.payee === 'Startsaldo';
/** Lines that only make the app's balance match the bank's. An entered bill already does that. */
const isBalanceFix = (r: { payee: string }) => r.payee === 'Startsaldo' || r.payee === 'Saldojustering';
const PAYMENT = /innbetal|betaling|payment|overføring|nedbetal/i;

const clampDay = (month: string, day: number) => `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`;

/** The day a billing period closes in a given month. Month end when the statement day isn't set. */
export function closeIn(month: string, statementDay: number | null) {
  return clampDay(month, statementDay ?? 31);
}

/** The most recent close before `date`, and the next one on or after it (a period is open through its close day). */
export function closesAround(date: string, statementDay: number | null) {
  const month = date.slice(0, 7);
  const thisClose = closeIn(month, statementDay);
  const last = date > thisClose ? thisClose : closeIn(addMonths(month, -1), statementDay);
  const next = date > thisClose ? closeIn(addMonths(month, 1), statementDay) : thisClose;
  return { last, next, before: (close: string) => closeIn(addMonths(close.slice(0, 7), -1), statementDay) };
}

/** When the bill for the period closing on `close` is due. */
export function dueFor(close: string, prevClose: string, t: CardTerms): { due: string; estimate: boolean } {
  if (t.due_day) {
    const sameMonth = clampDay(close.slice(0, 7), t.due_day);
    return { due: sameMonth > close ? sameMonth : clampDay(addMonths(close.slice(0, 7), 1), t.due_day), estimate: false };
  }
  // "Up to N interest-free days" counts from the first day of the period.
  if (t.free_days) return { due: addDays(prevClose, t.free_days), estimate: false };
  return { due: addDays(close, 20), estimate: true };
}

export function latestStatement(db: DB, accountId: number): CardStatement | null {
  return get<CardStatement>(db, 'SELECT * FROM card_statements WHERE account_id = ? ORDER BY closed DESC, id DESC LIMIT 1', accountId) ?? null;
}

/**
 * The terms, with the bank's bill filling the gaps: its date is the statement day (it's what the bank actually
 * uses), and its due day is the due day unless the terms give one or count interest-free days instead.
 */
export function effectiveTerms<T extends CardTerms>(c: T, s: CardStatement | null): T {
  if (!s) return c;
  const closeDay = Number(s.closed.slice(8, 10));
  const monthEnd = closeDay === daysInMonth(s.closed.slice(0, 7));
  return {
    ...c,
    statement_day: monthEnd ? 31 : closeDay,
    due_day: c.due_day ?? (c.free_days ? null : Number(s.due.slice(8, 10))),
  };
}

function label(close: string, statementDay: number | null) {
  const month = MONTHS[Number(close.slice(5, 7)) - 1];
  return !statementDay || statementDay >= 28 ? `${month}-regningen` : `regningen ${Number(close.slice(8, 10))}. ${month}`;
}

interface Row {
  id: number;
  date: string;
  amount: number;
  payee: string;
  raw_description: string;
  transfer_id: number | null;
  kind?: Purchase['kind'];
}

/**
 * The card's ledger up to `today`. `t` should be the effective terms (see effectiveTerms). Without an entered
 * bill it starts at the budget start; the opening balance then counts as the bill before it, since that's
 * where debt from before the start most likely sits.
 */
export function ledger(db: DB, t: CardTerms & { id: number }, start: string, today: string, s: CardStatement | null) {
  const select = (from: string) =>
    all<Row>(
      db,
      'SELECT id, date, amount, payee, raw_description, transfer_id FROM transactions WHERE account_id = ? AND date >= ? AND date <= ? ORDER BY date, id',
      t.id,
      from,
      today,
    );

  const buckets = new Map<string, Period>();
  type Charge = { id: number; date: string; payee: string; amount: number; left: number; kind: Purchase['kind'] };
  const charges = new Map<string, Charge[]>();
  const bucketFor = (date: string) => {
    const { next: close, before } = closesAround(date, t.statement_day);
    if (!buckets.has(close)) {
      const prev = before(close);
      buckets.set(close, {
        from: addDays(prev, 1),
        closes: close,
        due: dueFor(close, prev, t).due,
        label: label(close, t.statement_day),
        charged: 0,
        paid: 0,
        left: 0,
        status: 'open',
        fromBank: false,
      });
      charges.set(close, []);
    }
    return buckets.get(close)!;
  };
  const charge = (bucketDate: string, ch: { id: number; date: string; payee: string; amount: number; kind: Purchase['kind'] }) => {
    const b = bucketFor(bucketDate);
    b.charged += ch.amount;
    b.left += ch.amount;
    charges.get(b.closes)!.push({ ...ch, left: ch.amount });
  };

  let rows: Row[];
  if (s) {
    // The entered bill is exactly what the bank says. The purchases the app has from that period are shown on it;
    // whatever they don't explain (older debt, purchases the app never saw) is one line of its own.
    const bill = bucketFor(s.closed);
    bill.due = s.due;
    bill.fromBank = true;
    bill.charged = bill.left = s.amount;
    const raw = select(bill.from).filter((r) => !isBalanceFix(r));
    const known = raw
      .filter((r) => r.date <= s.closed && r.amount < 0)
      .map((r): Charge => ({ id: r.id, date: r.date, payee: r.payee || r.raw_description, amount: -r.amount, left: 0, kind: 'purchase' }));
    // The bill pays for its newest purchases; older ones in the period were covered before it (by a payment or
    // money on the card), as the bank's FIFO would have it.
    let need = s.amount;
    for (let i = known.length - 1; i >= 0 && need > 0; i--) {
      known[i].left = Math.min(need, known[i].amount);
      need -= known[i].left;
    }
    const items = [...known];
    if (need > 0)
      items.unshift({
        id: -1,
        date: bill.from,
        payee: known.length ? 'Eldre saldo og ukjente kjøp' : 'Regningen fra banken',
        amount: need,
        left: need,
        kind: 'unknown',
      });
    charges.set(bill.closes, items);

    rows = raw.filter((r) => r.date > s.closed);
    // The balance from the bank: what it doesn't explain happened between the bill and that day.
    if (s.balance !== null && s.balance_date) {
      const at = s.balance_date;
      const appOwed = s.amount - rows.filter((r) => r.date <= at).reduce((sum, r) => sum + r.amount, 0);
      const diff = s.balance - appOwed;
      if (diff !== 0) {
        const extra: Row = {
          id: -2,
          date: at,
          amount: -diff,
          payee: diff > 0 ? 'Kjøp banken har, men ikke appen' : 'Innbetalinger banken har, men ikke appen',
          raw_description: '',
          transfer_id: diff < 0 ? -1 : null,
          kind: 'unknown',
        };
        const i = rows.findIndex((r) => r.date > at);
        rows.splice(i < 0 ? rows.length : i, 0, extra);
      }
    }
  } else {
    rows = select(start);
  }

  const billed = (b: Period) => b.closes < today || (!!s && b.closes <= s.closed);
  for (const r of rows)
    if (r.amount < 0) {
      const opening = isOpening(r);
      // The balance at the start is older debt: it belongs to the bill before the start, not to new purchases.
      // An unknown amount from the bank's balance belongs after the entered bill, never on it.
      const bucketDate = opening ? addDays(r.date, -1) : s && r.date <= s.closed ? addDays(s.closed, 1) : r.date;
      charge(bucketDate, {
        id: r.id,
        date: r.date,
        payee: opening ? 'Saldo da dere startet med appen' : r.payee || r.raw_description,
        amount: -r.amount,
        kind: opening ? 'opening' : r.kind ?? 'purchase',
      });
    }
  const ordered = [...buckets.values()].sort((a, b) => a.closes.localeCompare(b.closes));
  const payBucket = (b: Period, amount: number) => {
    b.left -= amount;
    b.paid += amount;
    let rest = amount;
    for (const ch of charges.get(b.closes) ?? []) {
      if (rest <= 0) break;
      const take = Math.min(rest, ch.left);
      ch.left -= take;
      rest -= take;
    }
  };

  const payments: Payment[] = [];
  let credit = 0;
  for (const r of rows.filter((x) => x.amount > 0)) {
    const isPayment = !!r.transfer_id || isOpening(r) || PAYMENT.test(`${r.payee} ${r.raw_description}`);
    let rest = r.amount;
    const covered: Payment['covered'] = [];
    for (const b of ordered) {
      if (rest <= 0) break;
      if (b.left <= 0) continue;
      const take = Math.min(rest, b.left);
      payBucket(b, take);
      rest -= take;
      covered.push({ label: billed(b) ? b.label : UNBILLED_LABEL, amount: take });
    }
    credit += rest;
    payments.push({ id: r.id, date: r.date, amount: r.amount, kind: isPayment ? 'payment' : 'refund', text: r.payee || r.raw_description, covered, extra: rest });
  }
  // Charges after an overpayment use up the money left on the card.
  for (const b of ordered) {
    if (credit <= 0) break;
    const take = Math.min(credit, b.left);
    payBucket(b, take);
    credit -= take;
  }
  for (const b of ordered) b.status = !billed(b) ? 'open' : b.left <= 0 ? 'paid' : today > b.due ? 'overdue' : 'due';

  const sum = (st: Period['status']) => ordered.filter((b) => b.status === st).reduce((x, b) => x + b.left, 0);
  const rate = t.interest_rate ? t.interest_rate / 10000 : null;
  // Interest on what's overdue, from the start of each period (Norwegian cards charge from the purchase date).
  const accruedInterest = rate
    ? Math.round(ordered.filter((b) => b.status === 'overdue').reduce((x, b) => x + (b.left * rate * dayDiff(b.from, today)) / 365, 0))
    : null;

  // Every purchase from the last bill on, and anything older that isn't paid, with its deadline.
  const { last } = closesAround(today, t.statement_day);
  const keepFrom = s && s.closed > last ? s.closed : last;
  const purchases: Purchase[] = [];
  for (const b of ordered)
    for (const ch of charges.get(b.closes) ?? []) {
      if (ch.left <= 0 && b.closes < keepFrom) continue;
      const daysLeft = dayDiff(today, b.due);
      const status: Purchase['status'] = ch.left <= 0 ? 'paid' : daysLeft < 0 ? 'overdue' : 'free';
      const interest =
        rate && ch.left > 0 ? Math.round((ch.left * rate * (status === 'overdue' ? dayDiff(ch.date, today) : dayDiff(ch.date, b.due) + 30)) / 365) : null;
      purchases.push({
        id: ch.id,
        date: ch.date,
        payee: ch.payee,
        amount: ch.amount,
        left: Math.max(0, ch.left),
        due: b.due,
        daysLeft,
        freeDays: Math.max(0, dayDiff(ch.date, b.due)),
        status,
        interest,
        billed: billed(b),
        bill: billed(b) ? b.label : UNBILLED_LABEL,
        closes: b.closes,
        kind: ch.kind,
      });
    }
  // Most urgent first: by deadline, oldest purchase first (the order payments pay them down); paid ones last.
  purchases.sort((a, b) =>
    a.status === 'paid' && b.status === 'paid'
      ? b.date.localeCompare(a.date)
      : a.status === 'paid'
        ? 1
        : b.status === 'paid'
          ? -1
          : a.due.localeCompare(b.due) || a.date.localeCompare(b.date) || a.id - b.id,
  );

  const total = ordered.reduce((x, b) => x + b.left, 0);
  return {
    owed: total - credit,
    purchases,
    // The latest bills, and every one that isn't paid.
    periods: ordered
      .slice()
      .reverse()
      .filter((p, i) => i < 8 || p.left > 0),
    payments: payments.reverse().slice(0, 12),
    breakdown: { overdue: sum('overdue'), nextBill: sum('due'), unbilled: sum('open'), credit, accruedInterest },
  };
}
