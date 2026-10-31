/**
 * Small, clever helpers that look at the data and say something useful:
 * - syncHealth: a bank that has gone quiet compared with how often it usually sends transactions.
 * - payday: the salary just came in, so the budget can be filled in one go.
 */
import { all, get, type DB } from './db.ts';
import { addDays, addMonths, dayDiff, todayISO } from '../shared/months.ts';

export interface StaleAccount {
  accountId: number;
  name: string;
  /** Days since the last transaction from the bank. */
  days: number;
  /** How many days usually pass between transactions. */
  usual: number;
  /** "quiet": no new transactions for unusually long; "nosync": the scheduled sync hasn't run. */
  kind: 'quiet' | 'nosync';
  lastSyncAt: string | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export function syncHealth(db: DB, today = todayISO(), now = Date.now()): StaleAccount[] {
  const accounts = all<{ id: number; name: string; last_sync_at: string | null }>(
    db,
    `SELECT a.id, a.name, co.last_sync_at FROM accounts a
       JOIN connection_accounts ca ON ca.account_id = a.id JOIN connections co ON co.id = ca.connection_id
      WHERE a.closed = 0 AND co.status = 'active'`,
  );
  const out: StaleAccount[] = [];
  for (const a of accounts) {
    // The automatic sync runs every six hours; a day without one means something is stuck.
    if (a.last_sync_at && now - Date.parse(`${a.last_sync_at.replace(' ', 'T')}Z`) > 26 * 3_600_000) {
      out.push({ accountId: a.id, name: a.name, days: 0, usual: 0, kind: 'nosync', lastSyncAt: a.last_sync_at });
      continue;
    }
    const dates = all<{ date: string }>(
      db,
      `SELECT DISTINCT date FROM transactions WHERE account_id = ? AND date >= ? AND source NOT IN ('manual', 'freshstart', 'transfer') ORDER BY date`,
      a.id,
      addDays(today, -60),
    ).map((r) => r.date);
    if (dates.length < 6) continue; // Too little history to know what's normal.
    const gaps = dates.slice(1).map((d, i) => dayDiff(dates[i], d));
    const usual = Math.max(1, median(gaps));
    const days = dayDiff(dates[dates.length - 1], today);
    // Weekends are quiet anyway, so only flag clear silences.
    if (days >= 4 && days > usual * 3) out.push({ accountId: a.id, name: a.name, days, usual, kind: 'quiet', lastSyncAt: a.last_sync_at });
  }
  return out;
}

export interface Payday {
  id: number;
  date: string;
  amount: number;
  payee: string;
  reviewed: number;
  category_id: number | null;
  suggested_category_id: number | null;
  category_name: string | null;
}

/** The latest salary (5 000 kr or more, income category or "lønn" in the text) from the last five days. */
export function payday(db: DB, today = todayISO()): Payday | null {
  return (
    get<Payday>(
      db,
      `SELECT t.id, t.date, t.amount, t.payee, t.reviewed, t.category_id, t.suggested_category_id,
              COALESCE(c.name, sc.name) AS category_name
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id AND a.on_budget = 1
         LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN category_groups g ON g.id = c.group_id
         LEFT JOIN categories sc ON sc.id = t.suggested_category_id LEFT JOIN category_groups sg ON sg.id = sc.group_id
        WHERE t.amount >= 500000 AND t.date >= ? AND t.transfer_id IS NULL AND t.payee != 'Startsaldo'
          AND (g.is_income = 1 OR (t.category_id IS NULL AND sg.is_income = 1) OR lower(t.payee || ' ' || t.raw_description) LIKE '%lønn%')
        ORDER BY t.date DESC, t.amount DESC LIMIT 1`,
      addDays(today, -5),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// Smart tips on the Budsjett page. Each has a stable key so it can be dismissed once and stay away.

export interface Tip {
  key: string;
  kind: 'price' | 'power' | 'pay';
  title: string;
  text: string;
  /** One tap to act on it: set a monthly goal, or move money to a category. */
  action?: { label: string; type: 'target'; categoryId: number; amount: number } | { label: string; type: 'move'; categoryId: number; amount: number };
}

const kroner = (ore: number) => `${new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(Math.round(ore / 100))} kr`;

/**
 * Price increases on steady bills and subscriptions: Netflix going from 129 to 149 kr, insurance creeping up.
 * Only payees with a steady amount before (within 2 %) count, so power bills that swing every month don't.
 */
export function priceChanges(db: DB, today = todayISO()): Tip[] {
  const rows = all<{ payee: string; date: string; amount: number }>(
    db,
    `SELECT payee, date, -amount AS amount FROM transactions
      WHERE amount < 0 AND transfer_id IS NULL AND payee != '' AND date >= ? ORDER BY date`,
    addDays(today, -400),
  );
  const byPayee = new Map<string, typeof rows>();
  for (const r of rows) byPayee.set(r.payee.toLowerCase(), [...(byPayee.get(r.payee.toLowerCase()) ?? []), r]);
  const tips: Tip[] = [];
  for (const list of byPayee.values()) {
    if (list.length < 3) continue;
    const last = list[list.length - 1];
    if (dayDiff(last.date, today) > 60) continue;
    const before = list.slice(-7, -1);
    const usual = median(before.map((r) => r.amount));
    if (!before.every((r) => Math.abs(r.amount - usual) <= usual * 0.02)) continue;
    const diff = last.amount - usual;
    if (Math.abs(diff) < Math.max(1000, usual * 0.03) || Math.abs(diff) > usual * 0.6) continue;
    const gaps = list.slice(1).map((r, i) => dayDiff(list[i].date, r.date));
    const perYear = Math.round(365 / Math.max(7, median(gaps)));
    const up = diff > 0;
    tips.push({
      key: `price:${last.payee.toLowerCase()}:${last.amount}`,
      kind: 'price',
      title: up ? `${last.payee} har gått opp i pris` : `${last.payee} har blitt billigere`,
      text: `Fra ${kroner(usual)} til ${kroner(last.amount)} (${up ? '+' : ''}${Math.round((diff / usual) * 100)} %). Det er ${kroner(Math.abs(diff) * perYear)} ${
        up ? 'mer' : 'mindre'
      } i året.${up ? ' Verdt å sjekke om det finnes et billigere alternativ?' : ''}`,
    });
  }
  return tips;
}

/**
 * Electricity in Norway costs three to four times more in winter. Share of a year's power bill per month for a
 * typical household with electric heating (January first).
 */
const POWER_PROFILE = [0.135, 0.12, 0.105, 0.08, 0.06, 0.045, 0.04, 0.045, 0.055, 0.08, 0.105, 0.13];

/**
 * Seasonal power: from what you've paid so far (and last winter, if the history goes back that far), estimate the
 * coming winter months and suggest an even monthly amount, so January's bill doesn't wreck January.
 */
export function seasonalPower(db: DB, today = todayISO()): Tip[] {
  const month = Number(today.slice(5, 7));
  if (month < 8 || month > 12) return []; // Worth preparing from late summer to December.
  const cat = get<{ id: number; name: string; target_type: string | null; target_amount: number | null }>(
    db,
    `SELECT c.id, c.name, c.target_type, c.target_amount FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.is_income = 0 AND c.hidden = 0 AND (lower(c.name) LIKE '%strøm%' OR lower(c.name) LIKE '%energi%') LIMIT 1`,
  );
  if (!cat) return [];
  const spent = new Map(
    all<{ m: string; v: number }>(
      db,
      `SELECT substr(date, 1, 7) AS m, -SUM(amount) AS v FROM transactions
        WHERE category_id = ? AND date >= ? AND date < ? GROUP BY m HAVING v > 0`,
      cat.id,
      `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}-01`,
      `${today.slice(0, 7)}-01`,
    ).map((r) => [r.m, r.v]),
  );
  if (spent.size < 2) return [];
  // A year's bill, scaled up from the months we know.
  const known = [...spent.entries()];
  const shares = known.reduce((s, [m]) => s + POWER_PROFILE[Number(m.slice(5, 7)) - 1], 0);
  const yearly = known.reduce((s, [, v]) => s + v, 0) / shares;
  const even = Math.ceil(yearly / 12 / 10000) * 10000; // rounded up to whole hundreds
  const winter = [12, 1, 2].map((mm) => {
    const lastYear = spent.get(`${Number(today.slice(0, 4)) - (mm === 12 ? 1 : 0)}-${String(mm).padStart(2, '0')}`);
    return lastYear ?? yearly * POWER_PROFILE[mm - 1];
  });
  const winterAvg = winter.reduce((s, v) => s + v, 0) / 3;
  const current = cat.target_type === 'monthly' ? cat.target_amount ?? 0 : 0;
  if (even <= current * 1.1) return [];
  return [
    {
      key: `power:${today.slice(0, 7)}:${even}`,
      kind: 'power',
      title: 'Vinteren kommer: strømregningen øker',
      text: `${cat.name} blir trolig rundt ${kroner(winterAvg)} i måneden i desember–februar. Setter dere av ${kroner(even)} hver måned hele året, er pengene der når regningene kommer${
        current ? ` (i dag: ${kroner(current)} i måneden)` : ''
      }.`,
      action: { label: `Sett målet til ${kroner(even)}/mnd`, type: 'target', categoryId: cat.id, amount: even },
    },
  ];
}

/**
 * Norwegian pay quirks: June brings holiday pay (feriepenger) and November/December half tax, so the salary is
 * suddenly much bigger. Suggest giving the extra a job before it melts into everyday spending.
 */
export function payQuirks(db: DB, today = todayISO()): Tip[] {
  const month = today.slice(0, 7);
  const income = all<{ payee: string; date: string; amount: number }>(
    db,
    `SELECT t.payee, t.date, t.amount FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.on_budget = 1
       LEFT JOIN categories c ON c.id = COALESCE(t.category_id, t.suggested_category_id) LEFT JOIN category_groups g ON g.id = c.group_id
      WHERE t.amount >= 500000 AND t.transfer_id IS NULL AND g.is_income = 1 AND t.payee != 'Startsaldo' AND t.date >= ?
      ORDER BY t.date`,
    `${addMonths(month, -6)}-01`,
  );
  const tips: Tip[] = [];
  for (const now of income.filter((r) => r.date.startsWith(month))) {
    const earlier = income.filter((r) => r.payee.toLowerCase() === now.payee.toLowerCase() && r.date < `${month}-01`).map((r) => r.amount);
    if (earlier.length < 2) continue;
    const usual = median(earlier);
    const extra = now.amount - usual;
    if (now.amount < usual * 1.12 || extra < 200000) continue;
    const mm = Number(month.slice(5, 7));
    const why = mm === 6 ? 'feriepenger' : mm === 11 || mm === 12 ? 'halv skatt' : 'et tillegg eller en bonus';
    const target = get<{ id: number; name: string }>(
      db,
      `SELECT c.id, c.name FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE g.is_income = 0 AND c.hidden = 0
        ORDER BY ${mm === 6 ? "lower(c.name) LIKE '%ferie%'" : mm >= 11 ? "lower(c.name) LIKE '%jul%'" : "lower(c.name) LIKE '%buffer%'"} DESC,
                 lower(c.name) LIKE '%buffer%' DESC, lower(g.name) LIKE '%spar%' DESC LIMIT 1`,
    );
    tips.push({
      key: `pay:${now.payee.toLowerCase()}:${now.date}`,
      kind: 'pay',
      title: `${now.payee}: ${kroner(extra)} mer enn vanlig`,
      text: `Lønna er ${kroner(now.amount)} denne gangen, mot vanligvis ${kroner(usual)}. Det er nok ${why}. Gi de ekstra pengene en jobb før de forsvinner i hverdagen.`,
      action: target ? { label: `Sett ${kroner(extra)} av til ${target.name}`, type: 'move', categoryId: target.id, amount: extra } : undefined,
    });
  }
  return tips;
}

export function tips(db: DB, today = todayISO()): Tip[] {
  return [...payQuirks(db, today), ...seasonalPower(db, today), ...priceChanges(db, today)];
}
