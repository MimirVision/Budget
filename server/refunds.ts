/**
 * Refunds you're waiting for: mark a purchase as "returned" and the app watches for the money. When it comes back
 * it's matched automatically and suggested in the same category, so the purchase and the refund cancel out.
 */
import { all, get, run, type DB } from './db.ts';
import { addDays, dayDiff, todayISO } from '../shared/months.ts';

export interface Refund {
  id: number;
  transaction_id: number;
  amount: number;
  payee: string;
  created_at: string;
  resolved_transaction_id: number | null;
  resolved_at: string | null;
  purchase_date: string;
  account_name: string;
  days: number;
}

export function expectRefund(db: DB, transactionId: number, amount?: number): number {
  const t = get<{ id: number; amount: number; payee: string }>(db, 'SELECT id, amount, payee FROM transactions WHERE id = ?', transactionId);
  if (!t) throw new Error('Fant ikke kjøpet');
  if (t.amount >= 0) throw new Error('Bare kjøp (penger ut) kan vente på refusjon');
  const existing = get<{ id: number }>(db, 'SELECT id FROM refunds WHERE transaction_id = ? AND resolved_transaction_id IS NULL', t.id);
  const want = Math.round(Math.min(amount ?? -t.amount, -t.amount));
  if (existing) {
    run(db, 'UPDATE refunds SET amount = ? WHERE id = ?', want, existing.id);
    return existing.id;
  }
  return Number(run(db, 'INSERT INTO refunds(transaction_id, amount, payee) VALUES (?, ?, ?)', t.id, want, t.payee).lastInsertRowid);
}

export function listRefunds(db: DB, today = todayISO()): Refund[] {
  return all<Omit<Refund, 'days'>>(
    db,
    `SELECT r.*, t.date AS purchase_date, a.name AS account_name FROM refunds r
       JOIN transactions t ON t.id = r.transaction_id JOIN accounts a ON a.id = t.account_id
      WHERE r.resolved_transaction_id IS NULL OR r.resolved_at >= ?
      ORDER BY r.resolved_transaction_id IS NOT NULL, r.created_at`,
    addDays(today, -14),
  ).map((r) => ({ ...r, days: dayDiff(r.created_at.slice(0, 10), today) }));
}

/** The first word of a shop's name is what banks keep ("ELKJØP GRIMSTAD" / "Elkjøp Nordic AS"). */
const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-zæøå0-9 ]+/g, ' ')
    .split(/\s+/)
    .find((w) => w.length >= 3 && !['visa', 'vare', 'kjøp', 'retur', 'refusjon', 'kreditering'].includes(w)) ?? '';

/**
 * Matches money coming in against refunds you're waiting for: same shop name, no more than expected, after the
 * purchase, within 120 days. Returns how many were matched.
 */
export function matchRefunds(db: DB, incoming: Array<{ id: number; amount: number; date: string; raw_description: string; payee?: string }>): number {
  const open = all<{ id: number; amount: number; payee: string; category_id: number | null; date: string }>(
    db,
    `SELECT r.id, r.amount, r.payee, t.category_id, t.date FROM refunds r JOIN transactions t ON t.id = r.transaction_id
      WHERE r.resolved_transaction_id IS NULL`,
  );
  if (!open.length) return 0;
  let n = 0;
  const used = new Set<number>();
  for (const t of incoming) {
    if (t.amount <= 0) continue;
    const text = `${t.payee ?? ''} ${t.raw_description}`.toLowerCase();
    const r = open.find(
      (o) =>
        !used.has(o.id) &&
        t.amount <= o.amount + 100 &&
        t.date >= o.date &&
        dayDiff(o.date, t.date) <= 120 &&
        key(o.payee) !== '' &&
        text.includes(key(o.payee)),
    );
    if (!r) continue;
    used.add(r.id);
    run(db, "UPDATE refunds SET resolved_transaction_id = ?, resolved_at = datetime('now') WHERE id = ?", t.id, r.id);
    // Suggest the purchase's category, so the refund cancels the purchase out in the budget.
    if (r.category_id) run(db, "UPDATE transactions SET suggested_category_id = ?, suggestion_source = 'history' WHERE id = ? AND category_id IS NULL", r.category_id, t.id);
    n++;
  }
  return n;
}
