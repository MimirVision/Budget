/**
 * Faste regninger: the bills you know are coming (mortgage, power, insurance, kindergarten).
 * Each bill belongs to a category; the category's monthly goal is the sum of its bills, so "Fyll opp målene"
 * puts the right amount aside. A yearly bill becomes a twelfth each month.
 */
import { all, get, run, tx, type DB } from './db.ts';
import { getBudget } from './budget.ts';
import { detectRecurring } from './reports.ts';
import { addDays, addMonths, currentMonth, dayDiff, daysInMonth, todayISO } from '../shared/months.ts';

export interface Bill {
  id: number;
  name: string;
  amount: number;
  every: number;
  due_day: number | null;
  next_due: string | null;
  category_id: number | null;
  match: string;
  sort: number;
}

export interface BillStatus extends Bill {
  category_name: string | null;
  /** When it's due in the current cycle. */
  due: string;
  monthly: number;
  paid: { date: string; amount: number } | null;
}

export interface BillInput {
  name: string;
  amount: number;
  every?: number;
  due_day?: number | null;
  next_due?: string | null;
  category_id?: number | null;
  match?: string;
}

const EVERY = [1, 3, 6, 12];
const monthlyOf = (b: Pick<Bill, 'amount' | 'every'>) => Math.ceil(b.amount / b.every);

function dueThisCycle(b: Bill, today: string): string {
  const month = today.slice(0, 7);
  if (b.every === 1 || !b.next_due) {
    const day = Math.min(b.due_day ?? Number(b.next_due?.slice(8, 10) ?? 1), daysInMonth(month));
    return `${month}-${String(day).padStart(2, '0')}`;
  }
  // Roll the stored date forward until it's no more than a couple of weeks in the past.
  let due = b.next_due;
  for (let guard = 0; dayDiff(due, today) > 15 && guard < 200; guard++) {
    const m = addMonths(due.slice(0, 7), b.every);
    due = `${m}-${String(Math.min(Number(due.slice(8, 10)), daysInMonth(m))).padStart(2, '0')}`;
  }
  return due;
}

/** Whether the bill has been paid this cycle: a payment out with the bill's text, close to the due date. */
function findPayment(db: DB, b: Bill, due: string) {
  const needle = (b.match || b.name).trim();
  if (!needle) return null;
  return (
    get<{ date: string; amount: number }>(
      db,
      `SELECT date, -amount AS amount FROM transactions
        WHERE amount < 0 AND date BETWEEN ? AND ? AND (payee LIKE ? OR raw_description LIKE ?)
        ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1`,
      addDays(due, -15),
      addDays(due, 15),
      `%${needle}%`,
      `%${needle}%`,
      due,
    ) ?? null
  );
}

/** Bills still to be paid later this month (for the end-of-month forecast in Oversikt). */
export function billsLeftThisMonth(db: DB, today = todayISO()): { count: number; amount: number } {
  let count = 0;
  let amount = 0;
  for (const b of all<Bill>(db, 'SELECT * FROM bills')) {
    const due = dueThisCycle(b, today);
    if (due.slice(0, 7) !== today.slice(0, 7) || due < today || findPayment(db, b, due)) continue;
    count++;
    amount += b.amount;
  }
  return { count, amount };
}

/** Categories that hold fixed costs: those with a bill, or in a group for fixed expenses. */
export function fixedCategoryIds(db: DB): Set<number> {
  return new Set(
    all<{ id: number }>(
      db,
      `SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
        WHERE g.name LIKE '%fast%' OR g.name LIKE '%regning%' OR g.name LIKE '%bolig%'
       UNION SELECT category_id FROM bills WHERE category_id IS NOT NULL`,
    ).map((r) => r.id),
  );
}

export function listBills(db: DB, today = todayISO(), opts: { suggest?: boolean } = {}) {
  const bills = all<Bill & { category_name: string | null }>(
    db,
    'SELECT b.*, c.name AS category_name FROM bills b LEFT JOIN categories c ON c.id = b.category_id ORDER BY b.sort, b.id',
  );
  const out: BillStatus[] = bills.map((b) => {
    const due = dueThisCycle(b, today);
    return { ...b, due, monthly: monthlyOf(b), paid: findPayment(db, b, due) };
  });
  out.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));

  // How the bill categories stand in this month's budget.
  const budget = getBudget(db, currentMonth());
  const ids = new Set(out.map((b) => b.category_id).filter((x): x is number => x !== null));
  const cats = budget.groups.flatMap((g) => g.categories).filter((c) => ids.has(c.id));
  return {
    bills: out,
    monthlyTotal: out.reduce((s, b) => s + b.monthly, 0),
    needed: cats.reduce((s, c) => s + c.needed, 0),
    readyToAssign: budget.readyToAssign,
    suggestions: opts.suggest === false ? [] : suggestBills(db, out, today),
  };
}

/** Regular payments found in your history that aren't a bill yet. */
export function suggestBills(db: DB, existing: Bill[], today = todayISO()) {
  const known = existing.map((b) => (b.match || b.name).toLowerCase()).filter(Boolean);
  const every = { monthly: 1, quarterly: 3, yearly: 12 } as Record<string, number>;
  // Bills cost about the same each time, or sit with the other fixed costs (power varies with the season).
  const fixedGroup = fixedCategoryIds(db);
  return detectRecurring(db, today)
    .filter((r) => r.amount < 0 && every[r.cadence] && !known.some((k) => r.payee.toLowerCase().includes(k)))
    .filter((r) => r.steady || (r.categoryId !== null && fixedGroup.has(r.categoryId)))
    .map((r) => ({
      name: r.payee,
      amount: -r.amount,
      every: every[r.cadence],
      due_day: Number(r.nextDate.slice(8, 10)),
      next_due: r.nextDate,
      category_id: r.categoryId,
      category_name: r.categoryName,
      match: r.payee,
      occurrences: r.occurrences,
    }));
}

function clean(input: BillInput) {
  const name = String(input.name ?? '').trim().slice(0, 80);
  const amount = Math.round(Math.abs(Number(input.amount)));
  if (!name) throw new Error('Gi regningen et navn');
  if (!(amount > 0)) throw new Error('Beløpet må være større enn null');
  const every = EVERY.includes(Number(input.every)) ? Number(input.every) : 1;
  const due_day = input.due_day ? Math.min(31, Math.max(1, Math.round(Number(input.due_day)))) : null;
  const next_due = input.next_due && /^\d{4}-\d{2}-\d{2}$/.test(input.next_due) ? input.next_due : null;
  if (every > 1 && !next_due) throw new Error('Velg når regningen forfaller neste gang');
  return {
    name,
    amount,
    every,
    due_day: every === 1 ? due_day ?? (next_due ? Number(next_due.slice(8, 10)) : null) : null,
    next_due: every === 1 ? null : next_due,
    category_id: input.category_id ? Number(input.category_id) : null,
    match: String(input.match ?? name).trim().slice(0, 80),
  };
}

/**
 * Sets each category's monthly goal to the sum of its bills. A category whose last bill was removed or moved
 * loses the goal the bills gave it.
 */
export function syncBillTargets(db: DB, categoryIds: Array<number | null>) {
  for (const id of new Set(categoryIds)) {
    if (!id) continue;
    const bills = all<Bill>(db, 'SELECT * FROM bills WHERE category_id = ?', id);
    if (bills.length) {
      const total = bills.reduce((s, b) => s + monthlyOf(b), 0);
      run(db, "UPDATE categories SET target_type = 'monthly', target_amount = ?, target_date = NULL WHERE id = ?", total, id);
    } else {
      run(db, "UPDATE categories SET target_type = NULL, target_amount = NULL, target_date = NULL WHERE id = ? AND target_type = 'monthly'", id);
    }
  }
}

export function addBill(db: DB, input: BillInput): number {
  const b = clean(input);
  let id = 0;
  tx(db, () => {
    id = Number(
      run(
        db,
        `INSERT INTO bills(name, amount, every, due_day, next_due, category_id, match, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM bills))`,
        b.name,
        b.amount,
        b.every,
        b.due_day,
        b.next_due,
        b.category_id,
        b.match,
      ).lastInsertRowid,
    );
    syncBillTargets(db, [b.category_id]);
  });
  return id;
}

export function updateBill(db: DB, id: number, input: BillInput) {
  const b = clean(input);
  tx(db, () => {
    const before = get<Bill>(db, 'SELECT * FROM bills WHERE id = ?', id);
    if (!before) throw new Error('Fant ikke regningen');
    run(
      db,
      'UPDATE bills SET name = ?, amount = ?, every = ?, due_day = ?, next_due = ?, category_id = ?, match = ? WHERE id = ?',
      b.name,
      b.amount,
      b.every,
      b.due_day,
      b.next_due,
      b.category_id,
      b.match,
      id,
    );
    syncBillTargets(db, [before.category_id, b.category_id]);
  });
}

export function deleteBill(db: DB, id: number) {
  tx(db, () => {
    const before = get<Bill>(db, 'SELECT * FROM bills WHERE id = ?', id);
    run(db, 'DELETE FROM bills WHERE id = ?', id);
    if (before) syncBillTargets(db, [before.category_id]);
  });
}
