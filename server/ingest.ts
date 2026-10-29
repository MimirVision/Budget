/**
 * The single entry point for new transactions, no matter where they come from (bank sync, CSV, manual).
 * Every transaction goes through the same pipeline: dedupe → match with manual entries → clean payee →
 * suggest category (rules, your history, known merchants) → detect transfers between your own accounts.
 */
import { all, get, run, tx, type DB } from './db.ts';
import { cleanPayee, matchMerchant, payeeKey } from './payees.ts';
import { addDays } from '../shared/months.ts';

export interface IncomingTxn {
  date: string;
  amount: number; // øre
  description: string;
  payee?: string; // when the bank already gives a clean counterparty name
  externalId?: string;
  importHash?: string;
}

export interface IngestResult {
  added: number;
  duplicates: number;
  matched: number; // merged into a transaction you had already typed in manually
  categorized: number;
  transfers: number;
  ids: number[];
}

export interface Rule {
  id: number;
  match_type: 'contains' | 'equals' | 'starts';
  pattern: string;
  category_id: number | null;
  rename_to: string | null;
  account_id: number | null;
}

export function ruleMatches(rule: Rule, payee: string, raw: string, accountId: number): boolean {
  if (rule.account_id && rule.account_id !== accountId) return false;
  const p = rule.pattern.toLowerCase().trim();
  if (!p) return false;
  const targets = [payee.toLowerCase(), raw.toLowerCase()];
  switch (rule.match_type) {
    case 'equals':
      return targets.some((t) => t.trim() === p);
    case 'starts':
      return targets.some((t) => t.trim().startsWith(p));
    default:
      return targets.some((t) => t.includes(p));
  }
}

export function findRule(db: DB, payee: string, raw: string, accountId: number): Rule | undefined {
  // Most specific (longest) pattern wins.
  const rules = all<Rule>(db, 'SELECT * FROM rules ORDER BY length(pattern) DESC, id DESC');
  return rules.find((r) => ruleMatches(r, payee, raw, accountId));
}

function categoryByName(db: DB, name: string): number | undefined {
  return get<{ id: number }>(db, 'SELECT id FROM categories WHERE hidden = 0 AND name = ? COLLATE NOCASE', name)?.id;
}

export function suggestCategory(
  db: DB,
  payee: string,
  raw: string,
  amount: number,
  accountId: number,
): { categoryId: number; source: 'rule' | 'history' | 'merchant' } | undefined {
  const rule = findRule(db, payee, raw, accountId);
  if (rule?.category_id) return { categoryId: rule.category_id, source: 'rule' };

  // What did you pick last time for this payee (same direction of money)?
  const key = payeeKey(payee);
  if (key) {
    const hist = all<{ category_id: number; payee: string; n: number }>(
      db,
      `SELECT t.category_id, t.payee, COUNT(*) AS n, MAX(t.date) AS last
         FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE t.reviewed = 1 AND c.hidden = 0 AND (t.amount < 0) = (? < 0) AND t.payee = ? COLLATE NOCASE
        GROUP BY t.category_id ORDER BY n DESC, last DESC LIMIT 1`,
      amount,
      payee,
    );
    if (hist[0]) return { categoryId: hist[0].category_id, source: 'history' };
  }

  if (amount < 0) {
    const merchant = matchMerchant(raw) ?? matchMerchant(payee);
    const id = merchant?.category && categoryByName(db, merchant.category);
    if (id) return { categoryId: id, source: 'merchant' };
  } else if (/\b(lønn|lonn|lønning|salary|payroll|feriepenger)\b/i.test(raw)) {
    const id = categoryByName(db, 'Salary');
    if (id) return { categoryId: id, source: 'merchant' };
  }
  return undefined;
}

const TRANSFER_WORDS =
  /(overføring|overfør|transfer|top.?up|topup|revolut|innbetaling|kredittkort|credit card|card payment|nedbetaling|dnb|tf bank|sparebank|egen konto|own account|til sparing|fra sparing)/i;

/** Finds the other half of a transfer between your own accounts (same amount, opposite sign, a few days apart). */
export function findTransferCandidate(db: DB, txnId: number): number | undefined {
  const t = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', txnId);
  if (!t || t.transfer_id) return undefined;
  const candidates = all<any>(
    db,
    `SELECT * FROM transactions
      WHERE account_id != ? AND amount = ? AND transfer_id IS NULL
        AND date BETWEEN ? AND ? AND (reviewed = 0 OR category_id IS NULL)
      ORDER BY abs(julianday(date) - julianday(?)) LIMIT 3`,
    t.account_id,
    -t.amount,
    addDays(t.date, -5),
    addDays(t.date, 5),
    t.date,
  );
  if (candidates.length === 0) return undefined;
  const keyword = (c: any) => TRANSFER_WORDS.test(t.raw_description) || TRANSFER_WORDS.test(c.raw_description);
  if (candidates.length === 1) return candidates[0].id;
  const withKeyword = candidates.filter(keyword);
  return withKeyword.length === 1 ? withKeyword[0].id : undefined;
}

export function linkTransfer(db: DB, aId: number, bId: number) {
  const a = get<any>(db, 'SELECT t.*, a.on_budget FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?', aId);
  const b = get<any>(db, 'SELECT t.*, a.on_budget FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?', bId);
  if (!a || !b) throw new Error('Transaction not found');
  if (a.account_id === b.account_id) throw new Error('A transfer needs two different accounts');
  tx(db, () => {
    for (const [self, other] of [
      [a, b],
      [b, a],
    ]) {
      // Money moving between two budget accounts isn't spending. Money leaving the budget (e.g. to a
      // tracked mortgage or investment account) still needs a category on the budget side.
      const keepCategory = self.on_budget && !other.on_budget;
      run(
        db,
        `UPDATE transactions SET transfer_id = ?, suggested_transfer_id = NULL, reviewed = 1,
           category_id = CASE WHEN ? THEN coalesce(category_id, suggested_category_id) ELSE NULL END
         WHERE id = ?`,
        other.id,
        keepCategory ? 1 : 0,
        self.id,
      );
      run(db, 'DELETE FROM splits WHERE transaction_id = ? AND ? = 0', self.id, keepCategory ? 1 : 0);
    }
  });
}

export function unlinkTransfer(db: DB, id: number) {
  const t = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', id);
  if (!t?.transfer_id) return;
  const other = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', t.transfer_id);
  tx(db, () => {
    run(db, 'UPDATE transactions SET transfer_id = NULL, reviewed = 0 WHERE id IN (?, ?)', id, t.transfer_id);
    // A counterpart we invented ourselves has no reason to exist anymore.
    if (other?.source === 'transfer') run(db, 'DELETE FROM transactions WHERE id = ?', other.id);
  });
}

/** Marks a transaction as a transfer to an account where the other half hasn't shown up yet. */
export function transferToAccount(db: DB, txnId: number, accountId: number): number {
  const t = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', txnId);
  if (!t) throw new Error('Transaction not found');
  const existing = get<{ id: number }>(
    db,
    `SELECT id FROM transactions WHERE account_id = ? AND amount = ? AND transfer_id IS NULL AND date BETWEEN ? AND ?
     ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1`,
    accountId,
    -t.amount,
    addDays(t.date, -5),
    addDays(t.date, 5),
    t.date,
  );
  let otherId = existing?.id;
  if (!otherId) {
    const from = get<{ name: string }>(db, 'SELECT name FROM accounts WHERE id = ?', t.account_id)!;
    otherId = Number(
      run(
        db,
        `INSERT INTO transactions(account_id, date, amount, payee, raw_description, reviewed, source)
         VALUES (?, ?, ?, ?, ?, 1, 'transfer')`,
        accountId,
        t.date,
        -t.amount,
        `Transfer: ${from.name}`,
        t.raw_description,
      ).lastInsertRowid,
    );
  }
  linkTransfer(db, txnId, otherId);
  return otherId;
}

export function ingest(db: DB, accountId: number, incoming: IncomingTxn[], source: string): IngestResult {
  const result: IngestResult = { added: 0, duplicates: 0, matched: 0, categorized: 0, transfers: 0, ids: [] };
  const touched = new Set<number>();

  tx(db, () => {
    for (const t of incoming) {
      if (t.externalId && get(db, 'SELECT 1 FROM transactions WHERE account_id = ? AND external_id = ?', accountId, t.externalId)) {
        result.duplicates++;
        continue;
      }
      if (t.importHash && get(db, 'SELECT 1 FROM transactions WHERE account_id = ? AND import_hash = ?', accountId, t.importHash)) {
        result.duplicates++;
        continue;
      }

      // Something you typed in by hand (or a transfer we created) that the bank is now confirming.
      const manual = get<{ id: number }>(
        db,
        `SELECT id FROM transactions WHERE account_id = ? AND amount = ? AND external_id IS NULL AND import_hash IS NULL
           AND source IN ('manual', 'transfer') AND date BETWEEN ? AND ?
         ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1`,
        accountId,
        t.amount,
        addDays(t.date, -5),
        addDays(t.date, 5),
        t.date,
      );
      if (manual && !touched.has(manual.id)) {
        run(
          db,
          `UPDATE transactions SET external_id = ?, import_hash = ?, raw_description = ?, date = ?, source = ? WHERE id = ?`,
          t.externalId ?? null,
          t.importHash ?? null,
          t.description,
          t.date,
          source,
          manual.id,
        );
        touched.add(manual.id);
        result.matched++;
        continue;
      }

      // The same transaction arriving through a different route (e.g. a CSV covering days already synced).
      const otherRoute = get<{ id: number }>(
        db,
        `SELECT id FROM transactions WHERE account_id = ? AND amount = ? AND source NOT IN ('manual', 'transfer', ?)
           AND date BETWEEN ? AND ? LIMIT 1`,
        accountId,
        t.amount,
        source,
        addDays(t.date, -2),
        addDays(t.date, 2),
      );
      if (otherRoute && !touched.has(otherRoute.id)) {
        touched.add(otherRoute.id);
        result.duplicates++;
        continue;
      }

      const raw = t.description ?? '';
      const rule = findRule(db, t.payee ?? cleanPayee(raw), raw, accountId);
      const payee = rule?.rename_to || t.payee || cleanPayee(raw) || raw.slice(0, 80);
      const suggestion = suggestCategory(db, payee, raw, t.amount, accountId);
      if (rule) run(db, 'UPDATE rules SET hits = hits + 1 WHERE id = ?', rule.id);

      const id = Number(
        run(
          db,
          `INSERT INTO transactions(account_id, date, amount, payee, raw_description, suggested_category_id,
             suggestion_source, reviewed, source, external_id, import_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          accountId,
          t.date,
          t.amount,
          payee,
          raw,
          suggestion?.categoryId ?? null,
          suggestion?.source ?? null,
          source,
          t.externalId ?? null,
          t.importHash ?? null,
        ).lastInsertRowid,
      );
      touched.add(id);
      result.ids.push(id);
      result.added++;
      if (suggestion) result.categorized++;
    }

    for (const id of result.ids) {
      const other = findTransferCandidate(db, id);
      if (other) {
        run(db, 'UPDATE transactions SET suggested_transfer_id = ? WHERE id = ?', other, id);
        run(db, 'UPDATE transactions SET suggested_transfer_id = ? WHERE id = ? AND suggested_transfer_id IS NULL', id, other);
        result.transfers++;
      }
    }
  });
  return result;
}

/** Stable fingerprint for CSV rows. The occurrence index keeps two identical coffees on the same day apart. */
export function withImportHashes<T extends { date: string; amount: number; description: string }>(rows: T[]) {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}|${r.amount}|${r.description.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...r, importHash: `${base}|${n}` };
  });
}
