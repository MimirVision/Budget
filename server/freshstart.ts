/**
 * "Start på nytt" (like YNAB's Fresh Start): the budget begins on the first day of a chosen month.
 * Each account gets an opening balance on that date taken from the bank sync (or typed in for accounts
 * without one). Budget-account money lands in "Klar til fordeling"; categories start empty. Nothing
 * before the start date counts any more, but it stays visible as history. Fully undoable.
 */
import { all, get, getSetting, run, setSetting, tx, type DB } from './db.ts';
import { addDays, todayISO } from '../shared/months.ts';

export interface OpeningPreview {
  accountId: number;
  name: string;
  kind: string;
  onBudget: boolean;
  /** Where the number comes from: the bank's latest balance, or the app's own history. */
  source: 'bank' | 'history';
  opening: number;
}

const SOURCE = 'freshstart';

function incomeCategory(db: DB): number | null {
  return (
    get<{ id: number }>(
      db,
      "SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE g.is_income = 1 ORDER BY c.name = 'Annen inntekt' DESC, c.sort LIMIT 1",
    )?.id ?? null
  );
}

/** Balance each open account should start with on `start` (YYYY-MM-DD). */
export function previewFreshStart(db: DB, start: string): OpeningPreview[] {
  const accounts = all<any>(db, 'SELECT * FROM accounts WHERE closed = 0 ORDER BY sort, id');
  return accounts.map((a) => {
    // Openings from an earlier fresh start don't count; everything else on/after the start date does.
    const after = get<{ s: number }>(
      db,
      'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND date >= ? AND source != ?',
      a.id,
      start,
      SOURCE,
    )!.s;
    if (a.bank_balance !== null && a.bank_balance !== undefined) {
      // Synced: today's bank balance minus what has happened since the start date = balance on the start date.
      return { accountId: a.id, name: a.name, kind: a.kind, onBudget: !!a.on_budget, source: 'bank' as const, opening: a.bank_balance - after };
    }
    const before = get<{ s: number }>(
      db,
      'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND date < ? AND source != ?',
      a.id,
      start,
      SOURCE,
    )!.s;
    return { accountId: a.id, name: a.name, kind: a.kind, onBudget: !!a.on_budget, source: 'history' as const, opening: before };
  });
}

/** Starts the budget over. `overrides` are balances you typed in (e.g. a card without sync), in øre. */
export function applyFreshStart(db: DB, start: string, overrides: Record<number, number> = {}) {
  if (!/^\d{4}-\d{2}-01$/.test(start)) throw new Error('Velg en måned å starte fra');
  const preview = previewFreshStart(db, start);
  const income = incomeCategory(db);
  tx(db, () => {
    run(db, 'DELETE FROM transactions WHERE source = ?', SOURCE);
    for (const p of preview) {
      const opening = overrides[p.accountId] ?? p.opening;
      run(
        db,
        `INSERT INTO transactions(account_id, date, amount, payee, raw_description, category_id, reviewed, source)
         VALUES (?, ?, ?, 'Startsaldo', 'Startsaldo (ny start)', ?, 1, ?)`,
        p.accountId,
        start,
        opening,
        p.onBudget ? income : null,
        SOURCE,
      );
    }
    setSetting(db, 'budget_start', start);
    // Accounts whose opening was typed in shouldn't be moved by later syncs.
    setSetting(db, 'budget_start_manual', JSON.stringify(Object.keys(overrides).map(Number)));
  });
  return previewFreshStart(db, start).map((p) => ({ ...p, opening: overrides[p.accountId] ?? p.opening }));
}

export function undoFreshStart(db: DB) {
  tx(db, () => {
    run(db, 'DELETE FROM transactions WHERE source = ?', SOURCE);
    setSetting(db, 'budget_start', null);
    setSetting(db, 'budget_start_manual', null);
  });
}

/**
 * For the first days after the start, transactions from just before it may still be booked by the bank.
 * After each sync, re-anchor a synced account's opening so the app keeps matching the bank's balance.
 */
export function followBankAfterFreshStart(db: DB, accountId: number, today = todayISO()) {
  const start = getSetting(db, 'budget_start');
  if (!start || today > addDays(start, 10)) return;
  const manual: number[] = JSON.parse(getSetting(db, 'budget_start_manual') ?? '[]');
  if (manual.includes(accountId)) return;
  const p = previewFreshStart(db, start).find((x) => x.accountId === accountId);
  if (!p || p.source !== 'bank') return;
  run(db, 'UPDATE transactions SET amount = ? WHERE account_id = ? AND source = ?', p.opening, accountId, SOURCE);
}

/** An account added after a fresh start gets its own opening on the start date (from the bank balance). */
export function addFreshStartOpening(db: DB, accountId: number) {
  const start = getSetting(db, 'budget_start');
  if (!start) return;
  const p = previewFreshStart(db, start).find((x) => x.accountId === accountId);
  if (!p) return;
  run(db, 'DELETE FROM transactions WHERE account_id = ? AND source = ?', accountId, SOURCE);
  run(
    db,
    `INSERT INTO transactions(account_id, date, amount, payee, raw_description, category_id, reviewed, source)
     VALUES (?, ?, ?, 'Startsaldo', 'Startsaldo (ny start)', ?, 1, ?)`,
    accountId,
    start,
    p.opening,
    p.onBudget ? incomeCategory(db) : null,
    SOURCE,
  );
}
