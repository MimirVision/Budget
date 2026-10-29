import { all, get, type DB } from './db.ts';
import { addDays, addMonths, currentMonth, dayDiff, todayISO } from '../shared/months.ts';

export interface Recurring {
  payee: string;
  categoryId: number | null;
  categoryName: string | null;
  accountName: string;
  amount: number; // typical amount (median), negative for bills
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  lastDate: string;
  nextDate: string;
  occurrences: number;
}

const CADENCES: Array<{ name: Recurring['cadence']; days: number; tolerance: number }> = [
  { name: 'weekly', days: 7, tolerance: 2 },
  { name: 'monthly', days: 30, tolerance: 5 },
  { name: 'quarterly', days: 91, tolerance: 10 },
  { name: 'yearly', days: 365, tolerance: 20 },
];

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Spots bills and subscriptions from history: same payee, similar amount, regular interval. */
export function detectRecurring(db: DB, today = todayISO()): Recurring[] {
  const rows = all<any>(
    db,
    `SELECT t.payee, t.amount, t.date, t.category_id, c.name AS category_name, a.name AS account_name
       FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.transfer_id IS NULL AND t.date >= ? AND t.payee != ''
      ORDER BY t.date`,
    addDays(today, -400),
  );
  const byPayee = new Map<string, any[]>();
  for (const r of rows) {
    const key = `${r.payee.toLowerCase()}|${r.amount < 0 ? 'out' : 'in'}`;
    byPayee.set(key, [...(byPayee.get(key) ?? []), r]);
  }
  const out: Recurring[] = [];
  for (const list of byPayee.values()) {
    if (list.length < 2) continue;
    const amounts = list.map((r) => r.amount);
    const typical = median(amounts);
    // Allow ±25% wiggle (power bills vary), but not wildly different purchases at the same shop.
    const similar = list.filter((r) => Math.abs(r.amount - typical) <= Math.abs(typical) * 0.25);
    if (similar.length < 2) continue;
    const gaps = similar.slice(1).map((r, i) => dayDiff(similar[i].date, r.date));
    const gap = median(gaps);
    const cadence = CADENCES.find((c) => Math.abs(gap - c.days) <= c.tolerance);
    if (!cadence) continue;
    const regular = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tolerance * 2).length;
    const minOccurrences = cadence.name === 'yearly' ? 2 : cadence.name === 'quarterly' ? 2 : 3;
    if (similar.length < minOccurrences || regular < gaps.length * 0.7) continue;
    const last = similar[similar.length - 1];
    // Ignore things that seem to have stopped.
    if (dayDiff(last.date, today) > cadence.days * 2 + cadence.tolerance) continue;
    const step = cadence.name === 'monthly' ? null : cadence.days;
    let next = step ? addDays(last.date, step) : `${addMonths(last.date.slice(0, 7), 1)}-${last.date.slice(8, 10)}`;
    if (!/^\d{4}-\d{2}-(0[1-9]|[12]\d|3[01])$/.test(next) || Number.isNaN(Date.parse(next))) next = addDays(last.date, 30);
    while (next < today && dayDiff(next, today) > cadence.tolerance) next = step ? addDays(next, step) : addDays(next, 30);
    out.push({
      payee: last.payee,
      categoryId: last.category_id,
      categoryName: last.category_name,
      accountName: last.account_name,
      amount: typical,
      cadence: cadence.name,
      lastDate: last.date,
      nextDate: next,
      occurrences: similar.length,
    });
  }
  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

/** Spending per category for a month, with what's normal for you (3-month average) for comparison. */
export function spendingReport(db: DB, month: string) {
  const query = (from: string, to: string) =>
    all<{ id: number; name: string; group_name: string; total: number }>(
      db,
      `SELECT c.id, c.name, g.name AS group_name, SUM(x.amount) AS total FROM (
         SELECT t.category_id, t.amount, t.date FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE a.on_budget = 1 AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
         UNION ALL
         SELECT s.category_id, s.amount, t.date FROM splits s JOIN transactions t ON t.id = s.transaction_id
           JOIN accounts a ON a.id = t.account_id WHERE a.on_budget = 1
       ) x JOIN categories c ON c.id = x.category_id JOIN category_groups g ON g.id = c.group_id
       WHERE g.is_income = 0 AND x.date BETWEEN ? AND ? GROUP BY c.id`,
      from,
      to,
    );
  const now = query(`${month}-01`, `${month}-31`);
  const before = new Map(query(`${addMonths(month, -3)}-01`, `${addMonths(month, -1)}-31`).map((r) => [r.id, r.total / 3]));
  return now
    .map((r) => ({ ...r, spent: -r.total, usual: Math.round(-(before.get(r.id) ?? 0)) }))
    .filter((r) => r.spent > 0)
    .sort((a, b) => b.spent - a.spent);
}

/** Income vs spending per month. Transfers between own accounts are excluded. */
export function cashflowReport(db: DB, months = 12) {
  const end = currentMonth();
  const start = addMonths(end, -(months - 1));
  const rows = all<{ month: string; income: number; spending: number }>(
    db,
    `SELECT substr(t.date, 1, 7) AS month,
            SUM(CASE WHEN g.is_income = 1 THEN t.amount ELSE 0 END) AS income,
            SUM(CASE WHEN g.is_income = 0 OR g.is_income IS NULL THEN -t.amount ELSE 0 END) AS spending
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN category_groups g ON g.id = c.group_id
      WHERE a.on_budget = 1 AND t.transfer_id IS NULL AND t.date >= ?
      GROUP BY month`,
    `${start}-01`,
  );
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return Array.from({ length: months }, (_, i) => {
    const m = addMonths(start, i);
    const r = byMonth.get(m);
    return { month: m, income: r?.income ?? 0, spending: r?.spending ?? 0 };
  });
}

/** Month-end net worth across all accounts (budget and tracking), for the trend line. */
export function netWorthReport(db: DB, months = 12) {
  const end = currentMonth();
  return Array.from({ length: months }, (_, i) => {
    const m = addMonths(end, -(months - 1) + i);
    const r = get<{ assets: number; debts: number }>(
      db,
      `SELECT COALESCE(SUM(CASE WHEN bal > 0 THEN bal ELSE 0 END), 0) AS assets,
              COALESCE(SUM(CASE WHEN bal < 0 THEN -bal ELSE 0 END), 0) AS debts
         FROM (SELECT account_id, SUM(amount) AS bal FROM transactions WHERE date <= ? GROUP BY account_id)`,
      `${m}-31`,
    )!;
    return { month: m, assets: r.assets, debts: r.debts, netWorth: r.assets - r.debts };
  });
}
