/**
 * Small, clever helpers that look at the data and say something useful:
 * - syncHealth: a bank that has gone quiet compared with how often it usually sends transactions.
 * - payday: the salary just came in, so the budget can be filled in one go.
 */
import { all, get, type DB } from './db.ts';
import { addDays, dayDiff, todayISO } from '../shared/months.ts';

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
