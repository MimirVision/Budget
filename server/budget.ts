/**
 * Zero-based budget maths (the YNAB way):
 *  - Income lands in "Ready to assign".
 *  - You assign money to categories each month.
 *  - Available = everything ever assigned to a category + everything ever spent from it, so leftovers
 *    roll over automatically and overspending shows up as a negative you can cover.
 *  - Transfers between your own budget accounts (paying the credit card, topping up Revolut) are not spending.
 */
import { all, get, getSetting, run, tx, type DB } from './db.ts';
import { addMonths, currentMonth, daysInMonth, monthDiff, todayISO } from '../shared/months.ts';

export interface CategoryRow {
  id: number;
  group_id: number;
  name: string;
  hidden: number;
  target_type: 'monthly' | 'by_date' | 'balance' | null;
  target_amount: number | null;
  target_date: string | null;
  note: string | null;
  assigned: number;
  activity: number;
  available: number;
  lastMonthAssigned: number;
  lastMonthActivity: number;
  avgActivity: number; // average monthly spending over the last 3 months
  needed: number; // how much more to assign this month to stay on target
  targetProgress: number | null; // 0..1
}

export interface BudgetMonth {
  month: string;
  readyToAssign: number;
  income: number; // income received this month
  assigned: number;
  activity: number;
  available: number;
  uncategorized: { count: number; amount: number };
  unreviewed: number;
  pace: number; // how far into the month we are (0..1), for spending pace bars
  groups: Array<{ id: number; name: string; hidden: number; categories: CategoryRow[] }>;
}

/**
 * "Start på nytt": when set, the budget begins on this date. Older transactions and assignments stay as history
 * but don't count, and each account starts with an opening balance on the start date (see freshstart.ts).
 */
export function budgetStart(db: DB): string {
  return getSetting(db, 'budget_start') ?? '0000-01-01';
}

/** Sum of category activity per category for a set of months, counting splits and ignoring transfers. */
function activityBy(db: DB, where: string, ...params: any[]): Map<number, number> {
  const rows = all<{ category_id: number; total: number }>(
    db,
    `SELECT category_id, SUM(amount) AS total FROM (
       SELECT t.category_id, t.amount, t.date FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE a.on_budget = 1 AND t.category_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
       UNION ALL
       SELECT s.category_id, s.amount, t.date FROM splits s
         JOIN transactions t ON t.id = s.transaction_id JOIN accounts a ON a.id = t.account_id
        WHERE a.on_budget = 1 AND s.category_id IS NOT NULL
     ) WHERE date >= ? AND ${where} GROUP BY category_id`,
    budgetStart(db),
    ...params,
  );
  return new Map(rows.map((r) => [r.category_id, r.total]));
}

function assignedBy(db: DB, where: string, ...params: any[]): Map<number, number> {
  const rows = all<{ category_id: number; total: number }>(
    db,
    `SELECT category_id, SUM(amount) AS total FROM assignments WHERE month >= ? AND ${where} GROUP BY category_id`,
    budgetStart(db).slice(0, 7),
    ...params,
  );
  return new Map(rows.map((r) => [r.category_id, r.total]));
}

const endOf = (month: string) => `${month}-31`;

/**
 * What happens to overspending when a month ends (Innstillinger → Budsjett):
 * - 'carry' (default): the category stays negative into the next month until you cover it.
 * - 'reset' (like YNAB): the category starts the new month at 0, and the overspent amount is taken
 *   from that month's "Klar til fordeling" instead.
 */
export type OverspendMode = 'carry' | 'reset';
export function overspendMode(db: DB): OverspendMode {
  return getSetting(db, 'overspending') === 'reset' ? 'reset' : 'carry';
}

/** Per category: month → assigned + activity for that month, from the budget start up to `untilMonth`. */
function monthlyNet(db: DB, untilMonth: string): Map<number, Map<string, number>> {
  const start = budgetStart(db);
  const out = new Map<number, Map<string, number>>();
  const add = (cat: number, month: string, v: number) => {
    if (!out.has(cat)) out.set(cat, new Map());
    const m = out.get(cat)!;
    m.set(month, (m.get(month) ?? 0) + v);
  };
  for (const r of all<{ category_id: number; month: string; total: number }>(
    db,
    `SELECT category_id, month, SUM(amount) AS total FROM assignments WHERE month >= ? AND month <= ? GROUP BY category_id, month`,
    start.slice(0, 7),
    untilMonth,
  ))
    add(r.category_id, r.month, r.total);
  for (const r of all<{ category_id: number; month: string; total: number }>(
    db,
    `SELECT category_id, substr(date, 1, 7) AS month, SUM(amount) AS total FROM (
       SELECT t.category_id, t.amount, t.date FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE a.on_budget = 1 AND t.category_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
       UNION ALL
       SELECT s.category_id, s.amount, t.date FROM splits s
         JOIN transactions t ON t.id = s.transaction_id JOIN accounts a ON a.id = t.account_id
        WHERE a.on_budget = 1 AND s.category_id IS NOT NULL
     ) WHERE date >= ? AND date <= ? GROUP BY category_id, month`,
    start,
    endOf(untilMonth),
  ))
    add(r.category_id, r.month, r.total);
  return out;
}

/**
 * Walks a category month by month in 'reset' mode: only money left over carries forward; a negative end
 * of month is written off (and reported as overspending, which comes out of "Klar til fordeling").
 */
function walkReset(byMonth: Map<string, number> | undefined, untilMonth: string) {
  const months = [...(byMonth?.keys() ?? [])].filter((m) => m <= untilMonth).sort();
  let balance = 0;
  let last: string | null = null;
  const overspent = new Map<string, number>();
  for (const m of months) {
    if (last !== null && balance < 0) overspent.set(last, -balance);
    // Months with nothing happening in between still reset the balance.
    balance = Math.max(0, balance) + (byMonth!.get(m) ?? 0);
    last = m;
  }
  if (last !== null && last < untilMonth && balance < 0) {
    overspent.set(last, -balance);
    balance = 0;
  }
  return { available: last !== null && last < untilMonth ? Math.max(0, balance) : balance, overspent };
}

/** Overspending from finished months in 'reset' mode: it has been taken out of "Klar til fordeling". */
function writtenOffOverspending(db: DB): number {
  if (overspendMode(db) !== 'reset') return 0;
  const lastFinished = addMonths(currentMonth(), -1);
  const spendingCats = new Set(
    all<{ id: number }>(db, 'SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE g.is_income = 0').map((c) => c.id),
  );
  let total = 0;
  for (const [cat, byMonth] of monthlyNet(db, lastFinished)) {
    if (!spendingCats.has(cat)) continue;
    const { overspent } = walkReset(byMonth, currentMonth());
    for (const [m, v] of overspent) if (m <= lastFinished) total += v;
  }
  return total;
}

export function readyToAssign(db: DB): number {
  const income = get<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM (
       SELECT t.amount FROM transactions t JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = t.category_id JOIN category_groups g ON g.id = c.group_id
        WHERE a.on_budget = 1 AND g.is_income = 1 AND t.date >= ? AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
       UNION ALL
       SELECT s.amount FROM splits s JOIN transactions t ON t.id = s.transaction_id JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = s.category_id JOIN category_groups g ON g.id = c.group_id
        WHERE a.on_budget = 1 AND g.is_income = 1 AND t.date >= ?
     )`,
    budgetStart(db),
    budgetStart(db),
  )!.total;
  const assigned = get<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(a.amount), 0) AS total FROM assignments a
       JOIN categories c ON c.id = a.category_id JOIN category_groups g ON g.id = c.group_id WHERE g.is_income = 0 AND a.month >= ?`,
    budgetStart(db).slice(0, 7),
  )!.total;
  return income - assigned - writtenOffOverspending(db);
}

export function computeNeeded(
  c: Pick<CategoryRow, 'target_type' | 'target_amount' | 'target_date' | 'assigned' | 'available'>,
  month: string,
): { needed: number; progress: number | null } {
  const target = c.target_amount ?? 0;
  if (!c.target_type || target <= 0) return { needed: 0, progress: null };
  switch (c.target_type) {
    case 'monthly': {
      return { needed: Math.max(0, target - c.assigned), progress: Math.min(1, c.assigned / target) };
    }
    case 'balance': {
      return { needed: Math.max(0, target - c.available), progress: Math.max(0, Math.min(1, c.available / target)) };
    }
    case 'by_date': {
      if (!c.target_date || monthDiff(month, c.target_date) < 0) {
        return { needed: Math.max(0, target - c.available), progress: Math.max(0, Math.min(1, c.available / target)) };
      }
      // Spread what's still missing evenly over the months left, including this one.
      const monthsLeft = monthDiff(month, c.target_date) + 1;
      const startOfMonth = c.available - c.assigned;
      const perMonth = Math.ceil(Math.max(0, target - startOfMonth) / monthsLeft);
      return { needed: Math.max(0, perMonth - c.assigned), progress: Math.max(0, Math.min(1, c.available / target)) };
    }
  }
  return { needed: 0, progress: null };
}

export function getBudget(db: DB, month: string): BudgetMonth {
  const groups = all<any>(db, 'SELECT * FROM category_groups WHERE is_income = 0 ORDER BY sort, id');
  const cats = all<any>(
    db,
    `SELECT c.* FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE g.is_income = 0 ORDER BY c.sort, c.id`,
  );
  const prev = addMonths(month, -1);
  const assigned = assignedBy(db, 'month = ?', month);
  const assignedCum = assignedBy(db, 'month <= ?', month);
  const lastAssigned = assignedBy(db, 'month = ?', prev);
  const activity = activityBy(db, 'date BETWEEN ? AND ?', `${month}-01`, endOf(month));
  const activityCum = activityBy(db, 'date <= ?', endOf(month));
  const lastActivity = activityBy(db, 'date BETWEEN ? AND ?', `${prev}-01`, endOf(prev));
  const threeMonths = activityBy(db, 'date BETWEEN ? AND ?', `${addMonths(month, -3)}-01`, endOf(prev));
  const reset = overspendMode(db) === 'reset' ? monthlyNet(db, month) : null;

  let totalAssigned = 0;
  let totalActivity = 0;
  let totalAvailable = 0;

  const rows: CategoryRow[] = cats.map((c) => {
    const row: CategoryRow = {
      id: c.id,
      group_id: c.group_id,
      name: c.name,
      hidden: c.hidden,
      target_type: c.target_type,
      target_amount: c.target_amount,
      target_date: c.target_date,
      note: c.note,
      assigned: assigned.get(c.id) ?? 0,
      activity: activity.get(c.id) ?? 0,
      available: reset ? walkReset(reset.get(c.id), month).available : (assignedCum.get(c.id) ?? 0) + (activityCum.get(c.id) ?? 0),
      lastMonthAssigned: lastAssigned.get(c.id) ?? 0,
      lastMonthActivity: lastActivity.get(c.id) ?? 0,
      avgActivity: Math.round((threeMonths.get(c.id) ?? 0) / 3),
      needed: 0,
      targetProgress: null,
    };
    const t = computeNeeded(row, month);
    row.needed = t.needed;
    row.targetProgress = t.progress;
    totalAssigned += row.assigned;
    totalActivity += row.activity;
    totalAvailable += row.available;
    return row;
  });

  const income = get<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id
       JOIN categories c ON c.id = t.category_id JOIN category_groups g ON g.id = c.group_id
      WHERE a.on_budget = 1 AND g.is_income = 1 AND t.date BETWEEN ? AND ? AND t.payee != 'Startsaldo'`,
    `${month}-01`,
    endOf(month),
  )!.total;

  const uncategorized = get<{ count: number; amount: number }>(
    db,
    `SELECT COUNT(*) AS count, COALESCE(SUM(t.amount), 0) AS amount FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.on_budget = 1 AND t.category_id IS NULL AND t.transfer_id IS NULL AND t.date >= ?
        AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)`,
    budgetStart(db),
  )!;
  const unreviewed = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM transactions WHERE reviewed = 0 AND date >= ?', budgetStart(db))!.n;

  const today = todayISO();
  const cm = currentMonth();
  const pace = month < cm ? 1 : month > cm ? 0 : Number(today.slice(8, 10)) / daysInMonth(month);

  return {
    month,
    readyToAssign: readyToAssign(db),
    income,
    assigned: totalAssigned,
    activity: totalActivity,
    available: totalAvailable,
    uncategorized,
    unreviewed,
    pace,
    groups: groups.map((g) => ({ id: g.id, name: g.name, hidden: g.hidden, categories: rows.filter((r) => r.group_id === g.id) })),
  };
}

export function setAssigned(db: DB, month: string, categoryId: number, amount: number) {
  run(
    db,
    `INSERT INTO assignments(month, category_id, amount) VALUES (?, ?, ?)
     ON CONFLICT(month, category_id) DO UPDATE SET amount = excluded.amount`,
    month,
    categoryId,
    Math.round(amount),
  );
}

export function moveMoney(db: DB, month: string, fromId: number | null, toId: number | null, amount: number) {
  const budget = getBudget(db, month);
  const find = (id: number) => budget.groups.flatMap((g) => g.categories).find((c) => c.id === id);
  tx(db, () => {
    if (fromId) setAssigned(db, month, fromId, (find(fromId)?.assigned ?? 0) - amount);
    if (toId) setAssigned(db, month, toId, (find(toId)?.assigned ?? 0) + amount);
  });
}

export type AutoAssignMode = 'targets' | 'last_month_assigned' | 'last_month_spent' | 'average_spent' | 'reset';

/** One-click budgeting. Only fills what's missing, and never assigns more than you have (except "reset"). */
export function autoAssign(db: DB, month: string, mode: AutoAssignMode, categoryIds?: number[]) {
  const budget = getBudget(db, month);
  let pool = budget.readyToAssign;
  const cats = budget.groups
    .filter((g) => !g.hidden)
    .flatMap((g) => g.categories)
    .filter((c) => !c.hidden && (!categoryIds || categoryIds.includes(c.id)));
  let total = 0;
  tx(db, () => {
    for (const c of cats) {
      let want = 0;
      if (mode === 'reset') {
        setAssigned(db, month, c.id, 0);
        continue;
      }
      if (mode === 'targets') want = c.needed;
      else if (mode === 'last_month_assigned') want = c.lastMonthAssigned - c.assigned;
      else if (mode === 'last_month_spent') want = -c.lastMonthActivity - c.assigned;
      else if (mode === 'average_spent') want = -c.avgActivity - c.assigned;
      want = Math.max(0, Math.min(want, pool));
      if (want <= 0) continue;
      setAssigned(db, month, c.id, c.assigned + want);
      pool -= want;
      total += want;
    }
  });
  return { assigned: total };
}
