/**
 * Finds transactions that were registered more than once, explains why, and merges them.
 * Copies are the same amount in the same account a few days apart. What they came from tells why it happened.
 */
import { all, get, getSetting, run, setSetting, tx, type DB } from './db.ts';
import { forgetImport } from './ingest.ts';
import { addDays, dayDiff, todayISO } from '../shared/months.ts';

export type DuplicateReason = 'csv_and_sync' | 'transfer_copy' | 'manual_and_bank' | 'bank_changed_id' | 'two_bank_routes' | 'same_day_same_text' | 'other';

export interface DuplicateRow {
  id: number;
  date: string;
  amount: number;
  payee: string;
  raw_description: string;
  source: string;
  account_id: number;
  account_name: string;
  category_name: string | null;
  reviewed: number;
  transfer_id: number | null;
  memo: string;
  external_id: string | null;
}

export interface DuplicateGroup {
  key: string;
  reason: DuplicateReason;
  /** "sure": the copies came in different ways, or the bank changed the id. "maybe": could be two real purchases. */
  confidence: 'sure' | 'maybe';
  keep: number;
  rows: DuplicateRow[];
}

export interface DoubleLinkedAccounts {
  a: { id: number; name: string };
  b: { id: number; name: string };
  shared: number;
}

const BANK = new Set(['enablebanking', 'sparebank1']);
const norm = (s: string) => s.toLowerCase().replace(/[^a-zæøå0-9]+/g, ' ').trim();

function reasonFor(rows: DuplicateRow[]): { reason: DuplicateReason; confidence: 'sure' | 'maybe' } {
  const sources = new Set(rows.map((r) => r.source));
  const bank = rows.some((r) => BANK.has(r.source));
  if (sources.has('csv') && bank) return { reason: 'csv_and_sync', confidence: 'sure' };
  if (sources.has('transfer') && sources.size > 1) return { reason: 'transfer_copy', confidence: 'sure' };
  if (sources.has('manual') && sources.size > 1) return { reason: 'manual_and_bank', confidence: 'sure' };
  if ([...sources].filter((x) => BANK.has(x)).length > 1) return { reason: 'two_bank_routes', confidence: 'sure' };
  if (sources.size === 1 && bank) {
    // Two copies from the same bank on the same day with the same text can be two real purchases (two coffees).
    const sameDay = new Set(rows.map((r) => r.date)).size === 1;
    const sameText = new Set(rows.map((r) => norm(r.raw_description))).size === 1;
    if (sameDay && sameText) return { reason: 'same_day_same_text', confidence: 'maybe' };
    return { reason: 'bank_changed_id', confidence: 'sure' };
  }
  if (sources.size === 1 && sources.has('csv')) return { reason: 'same_day_same_text', confidence: 'maybe' };
  return { reason: 'other', confidence: 'maybe' };
}

/** Which copy to keep: the one you've already worked on, then the one the bank sync knows. */
function pickKeep(rows: DuplicateRow[]): number {
  const score = (r: DuplicateRow) =>
    (r.transfer_id ? 16 : 0) + (r.reviewed ? 8 : 0) + (r.category_name ? 4 : 0) + (r.memo ? 2 : 0) + (BANK.has(r.source) ? 1 : 0);
  return [...rows].sort((a, b) => score(b) - score(a) || a.id - b.id)[0].id;
}

function dismissed(db: DB): Set<string> {
  try {
    return new Set(JSON.parse(getSetting(db, 'duplicates_dismissed') ?? '[]'));
  } catch {
    return new Set();
  }
}

export function findDuplicates(db: DB, days = 400): { groups: DuplicateGroup[]; accounts: DoubleLinkedAccounts[] } {
  const from = addDays(todayISO(), -days);
  const rows = all<DuplicateRow>(
    db,
    `SELECT t.id, t.date, t.amount, t.payee, t.raw_description, t.source, t.account_id, a.name AS account_name,
            c.name AS category_name, t.reviewed, t.transfer_id, t.memo, t.external_id
       FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.date >= ? AND t.source != 'freshstart' AND t.payee != 'Startsaldo'
      ORDER BY t.account_id, t.amount, t.date, t.id`,
    from,
  );
  const skip = dismissed(db);
  const groups: DuplicateGroup[] = [];
  let cluster: DuplicateRow[] = [];
  const flush = () => {
    const real = cluster;
    if (real.length > 1 && !real.every((r) => r.source === 'manual')) {
      const key = real.map((r) => r.id).join(',');
      if (!skip.has(key)) groups.push({ key, ...reasonFor(real), keep: pickKeep(real), rows: real });
    }
    cluster = [];
  };
  for (const r of rows) {
    const first = cluster[0];
    if (first && (first.account_id !== r.account_id || first.amount !== r.amount || Math.abs(dayDiff(first.date, r.date)) > 4)) flush();
    cluster.push(r);
  }
  flush();
  groups.sort((a, b) => (a.confidence === b.confidence ? b.rows[0].date.localeCompare(a.rows[0].date) : a.confidence === 'sure' ? -1 : 1));

  // The same bank account linked twice (for example through both SpareBank 1 and Enable Banking) shows as two
  // accounts with the same transactions on the same days.
  const pairs = all<{ x: number; y: number; n: number }>(
    db,
    `SELECT a.account_id AS x, b.account_id AS y, COUNT(*) AS n
       FROM transactions a JOIN transactions b ON a.date = b.date AND a.amount = b.amount AND a.account_id < b.account_id
      WHERE a.date >= ? AND a.transfer_id IS NULL AND b.transfer_id IS NULL AND a.source != 'freshstart' AND b.source != 'freshstart'
      GROUP BY x, y HAVING n >= 5`,
    addDays(todayISO(), -90),
  );
  const counts = new Map(
    all<{ id: number; name: string; n: number }>(
      db,
      `SELECT a.id, a.name, COUNT(t.id) AS n FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id AND t.date >= ?
        GROUP BY a.id`,
      addDays(todayISO(), -90),
    ).map((r) => [r.id, r]),
  );
  const accounts = pairs
    .filter((p) => p.n >= 0.5 * Math.min(counts.get(p.x)?.n ?? 0, counts.get(p.y)?.n ?? 0))
    .map((p) => ({
      a: { id: p.x, name: counts.get(p.x)!.name },
      b: { id: p.y, name: counts.get(p.y)!.name },
      shared: p.n,
    }));
  return { groups, accounts };
}

/**
 * Keeps one copy and removes the rest. Anything you added to a removed copy (category, splits, note, receipts,
 * transfer link) moves over if the kept one doesn't have it. Removed bank ids are remembered so they don't come back.
 */
export function mergeDuplicates(db: DB, keepId: number, removeIds: number[]) {
  tx(db, () => {
    const keep = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', keepId);
    if (!keep) throw new Error('Fant ikke transaksjonen som skal beholdes');
    for (const id of removeIds) {
      if (id === keepId) continue;
      const r = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', id);
      if (!r || r.account_id !== keep.account_id || r.amount !== keep.amount) continue;
      const keepSplits = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM splits WHERE transaction_id = ?', keepId)!.n;
      if (!keep.category_id && !keepSplits && !keep.transfer_id) {
        if (r.category_id) {
          run(db, 'UPDATE transactions SET category_id = ? WHERE id = ?', r.category_id, keepId);
          keep.category_id = r.category_id;
        } else {
          run(db, 'UPDATE splits SET transaction_id = ? WHERE transaction_id = ?', keepId, id);
        }
      }
      if (!keep.memo && r.memo) {
        run(db, 'UPDATE transactions SET memo = ? WHERE id = ?', r.memo, keepId);
        keep.memo = r.memo;
      }
      if (r.reviewed && !keep.reviewed) {
        run(db, 'UPDATE transactions SET reviewed = 1 WHERE id = ?', keepId);
        keep.reviewed = 1;
      }
      run(db, 'UPDATE attachments SET transaction_id = ? WHERE transaction_id = ?', keepId, id);
      if (r.transfer_id) {
        if (!keep.transfer_id && !keep.category_id) {
          run(db, 'UPDATE transactions SET transfer_id = ? WHERE id = ?', r.transfer_id, keepId);
          run(db, 'UPDATE transactions SET transfer_id = ? WHERE id = ?', keepId, r.transfer_id);
          keep.transfer_id = r.transfer_id;
        } else {
          run(db, 'UPDATE transactions SET transfer_id = NULL, reviewed = 0 WHERE id = ? AND transfer_id = ?', r.transfer_id, id);
        }
      }
      run(db, 'UPDATE transactions SET suggested_transfer_id = NULL WHERE suggested_transfer_id = ?', id);
      forgetImport(db, id);
      run(db, 'DELETE FROM splits WHERE transaction_id = ?', id);
      run(db, 'DELETE FROM transactions WHERE id = ?', id);
    }
  });
}

/** "Ikke duplikat": hide this group from now on. */
export function dismissDuplicates(db: DB, key: string) {
  const set = dismissed(db);
  set.add(key);
  setSetting(db, 'duplicates_dismissed', JSON.stringify([...set].slice(-500)));
}
