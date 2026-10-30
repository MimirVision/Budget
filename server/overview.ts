/**
 * "Where did the money go?" for any period of whole months, compared with the period just before it.
 * Spending = money out of budget accounts that isn't a transfer between your own accounts, net of refunds.
 */
import { all, type DB } from './db.ts';
import { budgetStart, getBudget } from './budget.ts';
import { billsLeftThisMonth, fixedCategoryIds } from './bills.ts';
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
  /** Spending in fixed-cost categories (bills, mortgage); the rest is everyday spending. */
  fixedSpending: number;
  prevFixedSpending: number;
  groups: Array<{
    id: number | null;
    name: string;
    spent: number;
    prevSpent: number;
    fixed: boolean;
    categories: Array<{ id: number | null; name: string; spent: number; prevSpent: number; count: number; fixed: boolean }>;
  }>;
  /** Spending per account or card. */
  accounts: Array<{ id: number; name: string; spent: number; count: number }>;
  /** Everyday spending (no bills) per weekday, Monday first, averaged over the days in the period. */
  weekdays: Array<{ day: number; avg: number; total: number }>;
  /** Everyday spending per day of the month (one-month periods). */
  calendar: Array<{ date: string; spent: number }>;
  stats: { purchases: number; days: number; noSpendDays: number; avgPerDay: number; biggestDay: { date: string; spent: number } | null };
  /** Assigned against spent per category (one month, from the budget start). */
  budget: { assigned: number; spent: number; rows: Array<{ id: number; name: string; assigned: number; spent: number }> } | null;
  /** Where this month is heading: so far + everyday pace for the rest + bills not paid yet. */
  forecast: { projected: number; everydayRest: number; billsLeft: number; billsLeftCount: number } | null;
  /** Where the everyday money went (fixed bills left out). */
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
  const fixed = fixedCategoryIds(db);
  // Plain integers from our own table, so they can go straight into the SQL.
  const notFixed = `(category_id IS NULL OR category_id NOT IN (${[...fixed].map(Number).join(',') || 'NULL'}))`;
  const groups = new Map<string, Overview['groups'][number]>();
  for (const r of byCategory) {
    const gKey = String(r.group_id ?? 'none');
    if (!groups.has(gKey)) groups.set(gKey, { id: r.group_id, name: r.group_name ?? 'Uten kategori', spent: 0, prevSpent: 0, fixed: false, categories: [] });
    const g = groups.get(gKey)!;
    let c = g.categories.find((x) => x.id === r.category_id);
    if (!c) {
      const isFixed = r.category_id !== null && fixed.has(r.category_id);
      g.categories.push((c = { id: r.category_id, name: r.category ?? 'Uten kategori', spent: 0, prevSpent: 0, count: 0, fixed: isFixed }));
    }
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
    .map((g) => {
      const categories = g.categories.filter((c) => c.spent > 0 || c.prevSpent > 0).sort((a, b) => b.spent - a.spent);
      return { ...g, categories, fixed: categories.length > 0 && categories.every((c) => c.fixed) };
    })
    .filter((g) => g.spent > 0 || g.prevSpent > 0)
    .sort((a, b) => b.spent - a.spent);

  const payees = all<Overview['payees'][number]>(
    db,
    `${LINES} SELECT payee, SUM(spend) AS spent, COUNT(*) AS count, MAX(category) AS category
                FROM tagged WHERE is_income = 0 AND spend != 0 AND payee != '' AND ${notFixed} AND date BETWEEN ? AND ?
               GROUP BY lower(payee) HAVING spent > 0 ORDER BY spent DESC LIMIT 10`,
    from,
    to,
  );

  const largest = all<Overview['largest'][number]>(
    db,
    `${LINES} SELECT tid AS id, date, payee, amount, category, (SELECT name FROM accounts WHERE id = account_id) AS account
                FROM tagged WHERE is_income = 0 AND amount < 0 AND ${notFixed} AND date BETWEEN ? AND ?
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

  const fixedTotal = (a: string, b: string) =>
    all<{ v: number }>(db, `${LINES} SELECT COALESCE(SUM(spend), 0) AS v FROM tagged WHERE NOT ${notFixed} AND date BETWEEN ? AND ?`, a, b)[0].v;
  const fixedSpending = fixedTotal(from, to);

  const accounts = all<Overview['accounts'][number]>(
    db,
    `${LINES} SELECT account_id AS id, (SELECT name FROM accounts WHERE id = account_id) AS name, SUM(spend) AS spent,
                     SUM(CASE WHEN spend > 0 THEN 1 ELSE 0 END) AS count
                FROM tagged WHERE is_income = 0 AND date BETWEEN ? AND ? GROUP BY account_id HAVING spent > 0 ORDER BY spent DESC`,
    from,
    to,
  );

  // Days that have actually happened in the period.
  const today = todayISO();
  const lastDate = to < today ? to.slice(0, 7) + '-' + String(daysInMonth(to.slice(0, 7))).padStart(2, '0') : today;
  const dayCount = from > today ? 0 : Math.max(0, Math.round((Date.parse(lastDate) - Date.parse(from)) / 86_400_000) + 1);
  const everydayByDay = new Map(
    all<{ date: string; spent: number; n: number }>(
      db,
      `${LINES} SELECT date, SUM(spend) AS spent, SUM(CASE WHEN spend > 0 THEN 1 ELSE 0 END) AS n
                  FROM tagged WHERE is_income = 0 AND ${notFixed} AND date BETWEEN ? AND ? GROUP BY date`,
      from,
      lastDate,
    ).map((r) => [r.date, r]),
  );
  const weekdays = Array.from({ length: 7 }, (_, day) => ({ day, avg: 0, total: 0, n: 0 }));
  let purchases = 0;
  let noSpendDays = 0;
  let everyday = 0;
  let biggestDay: { date: string; spent: number } | null = null;
  const calendar: Overview['calendar'] = [];
  for (let i = 0; i < dayCount; i++) {
    const date = new Date(Date.parse(`${from}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const r = everydayByDay.get(date);
    const spent = Math.max(0, r?.spent ?? 0);
    const w = weekdays[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
    w.total += spent;
    w.n++;
    purchases += r?.n ?? 0;
    everyday += spent;
    if (spent === 0) noSpendDays++;
    if (spent > 0 && (!biggestDay || spent > biggestDay.spent)) biggestDay = { date, spent };
    if (span === 1) calendar.push({ date, spent });
  }

  let budget: Overview['budget'] = null;
  if (span === 1 && month >= start.slice(0, 7)) {
    const b = getBudget(db, month);
    const rows = b.groups
      .filter((g) => !g.hidden)
      .flatMap((g) => g.categories)
      .filter((c) => !c.hidden && (c.assigned > 0 || c.activity < 0))
      .map((c) => ({ id: c.id, name: c.name, assigned: c.assigned, spent: Math.max(0, -c.activity) }));
    if (rows.some((r) => r.assigned > 0))
      budget = { assigned: rows.reduce((s, r) => s + r.assigned, 0), spent: rows.reduce((s, r) => s + r.spent, 0), rows };
  }

  let forecast: Overview['forecast'] = null;
  const elapsed = Number(today.slice(8, 10));
  if (span === 1 && month === today.slice(0, 7) && elapsed >= 3) {
    const left = daysInMonth(month) - elapsed;
    const bills = billsLeftThisMonth(db, today);
    // Without any bills set up, assume the fixed costs end up like last month.
    const fixedLeft = bills.count || all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM bills')[0].n
      ? bills.amount
      : Math.max(0, fixedTotal(prevFrom, prevTo) - fixedSpending);
    const everydayRest = Math.round((everyday / elapsed) * left);
    forecast = { projected: now.spending + everydayRest + fixedLeft, everydayRest, billsLeft: fixedLeft, billsLeftCount: bills.count };
  }

  return {
    fixedSpending,
    prevFixedSpending: fixedTotal(prevFrom, prevTo),
    accounts,
    weekdays: weekdays.map(({ day, total, n }) => ({ day, total, avg: n ? Math.round(total / n) : 0 })),
    calendar,
    stats: { purchases, days: dayCount, noSpendDays, avgPerDay: dayCount ? Math.round(everyday / dayCount) : 0, biggestDay },
    budget,
    forecast,
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
