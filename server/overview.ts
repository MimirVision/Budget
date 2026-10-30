/**
 * "Where did the money go?" for any period of whole months, compared with the period just before it.
 * Spending = money out of budget accounts that isn't a transfer between your own accounts, net of refunds.
 */
import { all, type DB } from './db.ts';
import { budgetStart } from './budget.ts';
import { addMonths, daysInMonth, todayISO } from '../shared/months.ts';

export interface Overview {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  income: number;
  spending: number;
  prevIncome: number;
  prevSpending: number;
  /** Money that came in without a category yet (e.g. a salary waiting in Gjennomgå). */
  pendingIncome: number;
  /** Set when the period reaches back before "Start på nytt": those months are history and may count transfers wrong. */
  historyBefore: string | null;
  groups: Array<{
    id: number | null;
    name: string;
    spent: number;
    prevSpent: number;
    categories: Array<{ id: number | null; name: string; spent: number; prevSpent: number; count: number }>;
  }>;
  payees: Array<{ payee: string; spent: number; count: number; category: string | null }>;
  largest: Array<{ id: number; date: string; payee: string; amount: number; category: string | null; account: string }>;
  /** Cumulative spending per day of the month (only for one-month periods), with last month for comparison. */
  daily: Array<{ day: number; cum: number | null; prevCum: number | null }>;
  /** Income and spending per month across the period (for longer periods). */
  months: Array<{ month: string; income: number; spending: number }>;
}

// Every budget line: whole transactions, or their split parts. Transfers between budget accounts are left out;
// the opening balance isn't real income either.
const lines = (start: string) => `
  WITH lines AS (
    SELECT t.id AS tid, t.date, t.amount, t.category_id, t.payee, t.account_id FROM transactions t
      JOIN accounts a ON a.id = t.account_id
     WHERE a.on_budget = 1 AND t.payee != 'Startsaldo' AND t.date >= '${start}'
       AND (t.transfer_id IS NULL OR t.category_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
    UNION ALL
    SELECT t.id, t.date, s.amount, s.category_id, t.payee, t.account_id FROM splits s
      JOIN transactions t ON t.id = s.transaction_id JOIN accounts a ON a.id = t.account_id
     WHERE a.on_budget = 1 AND t.date >= '${start}'
  ), tagged AS (
    SELECT l.*, c.name AS category, g.id AS group_id, g.name AS group_name, COALESCE(g.is_income, 0) AS is_income,
           -- Spending: categorised lines (net of refunds) plus uncategorised money going out. Uncategorised money
           -- coming in (e.g. a salary not reviewed yet) is neither spending nor known income.
           CASE WHEN COALESCE(g.is_income, 0) = 0 AND (l.category_id IS NOT NULL OR l.amount < 0) THEN -l.amount ELSE 0 END AS spend,
           CASE WHEN g.is_income = 1 THEN l.amount ELSE 0 END AS inc
      FROM lines l LEFT JOIN categories c ON c.id = l.category_id LEFT JOIN category_groups g ON g.id = c.group_id
  )`;

const end = (month: string) => `${month}-31`;

export function overview(db: DB, month: string, span: number): Overview {
  // A fresh start ("Start på nytt") resets the budget, not history: older months still show where the money went.
  const LINES = lines('0000-01-01');
  const start = budgetStart(db);
  const startMonth = addMonths(month, -(span - 1));
  const from = `${startMonth}-01`;
  const to = end(month);
  const prevStart = addMonths(startMonth, -span);
  const prevFrom = `${prevStart}-01`;
  const prevTo = end(addMonths(startMonth, -1));

  const totals = (a: string, b: string) =>
    all<{ income: number; spending: number; pending: number }>(
      db,
      `${LINES} SELECT COALESCE(SUM(inc), 0) AS income, COALESCE(SUM(spend), 0) AS spending,
                       COALESCE(SUM(CASE WHEN category_id IS NULL AND amount > 0 THEN amount END), 0) AS pending
                  FROM tagged WHERE date BETWEEN ? AND ?`,
      a,
      b,
    )[0];
  const now = totals(from, to);
  const prev = totals(prevFrom, prevTo);

  const byCategory = all<{ category_id: number | null; category: string | null; group_id: number | null; group_name: string | null; spent: number; count: number; period: string }>(
    db,
    `${LINES} SELECT category_id, category, group_id, group_name, SUM(spend) AS spent, COUNT(*) AS count,
                     CASE WHEN date >= ? THEN 'now' ELSE 'prev' END AS period
                FROM tagged WHERE is_income = 0 AND spend != 0 AND date BETWEEN ? AND ?
               GROUP BY category_id, period`,
    from,
    prevFrom,
    to,
  );
  const groups = new Map<string, Overview['groups'][number]>();
  for (const r of byCategory) {
    const gKey = String(r.group_id ?? 'none');
    if (!groups.has(gKey)) groups.set(gKey, { id: r.group_id, name: r.group_name ?? 'Uten kategori', spent: 0, prevSpent: 0, categories: [] });
    const g = groups.get(gKey)!;
    let c = g.categories.find((x) => x.id === r.category_id);
    if (!c) g.categories.push((c = { id: r.category_id, name: r.category ?? 'Uten kategori', spent: 0, prevSpent: 0, count: 0 }));
    if (r.period === 'now') {
      c.spent += r.spent;
      c.count += r.count;
      g.spent += r.spent;
    } else {
      c.prevSpent += r.spent;
      g.prevSpent += r.spent;
    }
  }
  const groupList = [...groups.values()]
    .map((g) => ({ ...g, categories: g.categories.filter((c) => c.spent > 0 || c.prevSpent > 0).sort((a, b) => b.spent - a.spent) }))
    .filter((g) => g.spent > 0 || g.prevSpent > 0)
    .sort((a, b) => b.spent - a.spent);

  const payees = all<Overview['payees'][number]>(
    db,
    `${LINES} SELECT payee, SUM(spend) AS spent, COUNT(*) AS count, MAX(category) AS category
                FROM tagged WHERE is_income = 0 AND spend != 0 AND payee != '' AND date BETWEEN ? AND ?
               GROUP BY lower(payee) HAVING spent > 0 ORDER BY spent DESC LIMIT 10`,
    from,
    to,
  );

  const largest = all<Overview['largest'][number]>(
    db,
    `${LINES} SELECT tid AS id, date, payee, amount, category, (SELECT name FROM accounts WHERE id = account_id) AS account
                FROM tagged WHERE is_income = 0 AND amount < 0 AND date BETWEEN ? AND ?
               ORDER BY amount ASC LIMIT 5`,
    from,
    to,
  );

  let daily: Overview['daily'] = [];
  if (span === 1) {
    const perDay = (a: string, b: string) =>
      new Map(
        all<{ day: number; spent: number }>(
          db,
          `${LINES} SELECT CAST(substr(date, 9, 2) AS INTEGER) AS day, SUM(spend) AS spent
                      FROM tagged WHERE date BETWEEN ? AND ? GROUP BY day`,
          a,
          b,
        ).map((r) => [r.day, r.spent]),
      );
    const cur = perDay(from, to);
    const before = perDay(prevFrom, prevTo);
    const today = todayISO();
    const thisMonth = today.slice(0, 7);
    const lastDay = month === thisMonth ? Number(today.slice(8, 10)) : month > thisMonth ? 0 : daysInMonth(month);
    const prevDays = daysInMonth(prevStart);
    let cum = 0;
    let prevCum = 0;
    for (let day = 1; day <= Math.max(daysInMonth(month), prevDays); day++) {
      cum += cur.get(day) ?? 0;
      prevCum += before.get(day) ?? 0;
      daily.push({ day, cum: day <= lastDay ? cum : null, prevCum: day <= prevDays ? prevCum : null });
    }
    daily = daily.slice(0, daysInMonth(month));
  }

  const monthRows = all<{ month: string; income: number; spending: number }>(
    db,
    `${LINES} SELECT substr(date, 1, 7) AS month, COALESCE(SUM(inc), 0) AS income, COALESCE(SUM(spend), 0) AS spending
                FROM tagged WHERE date BETWEEN ? AND ? GROUP BY month`,
    from,
    to,
  );
  const byMonth = new Map(monthRows.map((r) => [r.month, r]));
  const months = Array.from({ length: span }, (_, i) => {
    const m = addMonths(startMonth, i);
    return { month: m, income: byMonth.get(m)?.income ?? 0, spending: byMonth.get(m)?.spending ?? 0 };
  });

  return {
    from,
    to,
    prevFrom,
    prevTo,
    income: now.income,
    spending: now.spending,
    prevIncome: prev.income,
    prevSpending: prev.spending,
    pendingIncome: now.pending,
    historyBefore: start !== '0000-01-01' && from < start ? start : null,
    groups: groupList,
    payees,
    largest,
    daily,
    months,
  };
}
