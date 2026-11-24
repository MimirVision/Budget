/**
 * The single entry point for new transactions, no matter where they come from (bank sync, CSV, manual).
 * Every transaction goes through the same pipeline: dedupe → match with manual entries → clean payee →
 * suggest category (rules, your history, known merchants) → detect transfers between your own accounts.
 */
import { all, get, getSetting, run, tx, type DB } from './db.ts';
import { cleanPayee, matchMerchant } from './payees.ts';
import { addDays, dayDiff } from '../shared/months.ts';
import { matchRefunds } from './refunds.ts';

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
  /** Categorised and approved on their own, because the app was sure (see Suggester.sure). */
  autoApproved: number;
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
  return new Suggester(db).rule(payee, raw, accountId);
}

/**
 * Category suggestions. Loads rules, your categorisation history and category names once, so suggesting for a
 * whole bank sync or CSV file costs a handful of queries instead of several per transaction.
 */
export class Suggester {
  private rules: Rule[];
  private history = new Map<string, number>();
  /** Per payee and direction: how many you've gone through, how many got the usual category, and the largest. */
  private stats = new Map<string, { total: number; usual: number; largest: number }>();
  private categories = new Map<string, number>();

  constructor(db: DB) {
    // Most specific wins: an exact name (a payee's own category) first, then the longest pattern.
    this.rules = all<Rule>(db, "SELECT * FROM rules ORDER BY match_type = 'equals' DESC, length(pattern) DESC, id DESC");
    const hist = all<{ payee: string; outflow: number; category_id: number; n: number; last: string; largest: number }>(
      db,
      `SELECT lower(t.payee) AS payee, t.amount < 0 AS outflow, t.category_id, COUNT(*) AS n, MAX(t.date) AS last, MAX(abs(t.amount)) AS largest
         FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE t.reviewed = 1 AND c.hidden = 0 AND t.payee != ''
        GROUP BY lower(t.payee), t.amount < 0, t.category_id
        ORDER BY n DESC, last DESC`,
    );
    // Rows come most-used first, so the first one per payee is what you usually pick.
    for (const h of hist) {
      const key = `${h.payee}|${h.outflow ? 1 : 0}`;
      if (!this.history.has(key)) this.history.set(key, h.category_id);
      const st = this.stats.get(key) ?? { total: 0, usual: h.n, largest: 0 };
      st.total += h.n;
      st.largest = Math.max(st.largest, h.largest);
      this.stats.set(key, st);
    }
    for (const c of all<{ id: number; name: string }>(db, 'SELECT id, name FROM categories WHERE hidden = 0')) {
      this.categories.set(c.name.toLowerCase(), c.id);
    }
  }

  /**
   * Whether a suggestion is safe to use without asking: a rule you made (a payee's fixed category), or what you
   * have always (or nearly always) picked for this payee, for an amount like the ones before. The first purchase
   * from a new payee, a payee you've put in different categories, and an amount far above the usual are left for
   * you to look at.
   */
  sure(payee: string, amount: number, source: string | null, categoryId: number | null): boolean {
    if (!categoryId) return false;
    if (source === 'rule') return true;
    if (source !== 'history') return false;
    const key = `${payee.toLowerCase()}|${amount < 0 ? 1 : 0}`;
    const st = this.stats.get(key);
    if (!st || this.history.get(key) !== categoryId) return false;
    if (st.usual / st.total < 0.8) return false;
    // Much more than ever before from them (e.g. 4 000 kr at a café): worth a look.
    if (Math.abs(amount) > Math.max(st.largest * 3, st.largest + 50_000)) return false;
    return true;
  }

  rule(payee: string, raw: string, accountId: number): Rule | undefined {
    return this.rules.find((r) => ruleMatches(r, payee, raw, accountId));
  }

  suggest(payee: string, raw: string, amount: number, accountId: number): { categoryId: number; source: 'rule' | 'history' | 'merchant' } | undefined {
    const rule = this.rule(payee, raw, accountId);
    if (rule?.category_id) return { categoryId: rule.category_id, source: 'rule' };

    // What did you pick last time for this payee (same direction of money)?
    const fromHistory = this.history.get(`${payee.toLowerCase()}|${amount < 0 ? 1 : 0}`);
    if (fromHistory) return { categoryId: fromHistory, source: 'history' };

    if (amount < 0) {
      const merchant = matchMerchant(raw) ?? matchMerchant(payee);
      const id = merchant?.category && this.categories.get(merchant.category.toLowerCase());
      if (id) return { categoryId: id, source: 'merchant' };
    } else if (/\b(lønn|lonn|lønning|salary|payroll|feriepenger)\b/i.test(raw)) {
      const id = this.categories.get('lønn');
      if (id) return { categoryId: id, source: 'merchant' };
    }
    return undefined;
  }
}

export function suggestCategory(db: DB, payee: string, raw: string, amount: number, accountId: number) {
  return new Suggester(db).suggest(payee, raw, amount, accountId);
}

const TRANSFER_WORDS =
  /(overføring|overfør|transfer|top.?up|topup|revolut|innbetaling|kredittkort|credit card|card payment|nedbetaling|dnb|tf bank|sparebank|egen konto|own account|til sparing|fra sparing)/i;

/** Finds the other half of a transfer between your own accounts (same amount, opposite sign, a few days apart). */
export function findTransferCandidate(db: DB, txnId: number): number | undefined {
  const t = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', txnId);
  if (!t || t.transfer_id || t.not_transfer) return undefined;
  const candidates = all<any>(
    db,
    `SELECT * FROM transactions
      WHERE account_id != ? AND amount = ? AND transfer_id IS NULL AND not_transfer = 0
        AND (suggested_transfer_id IS NULL OR suggested_transfer_id = ?)
        AND date BETWEEN ? AND ? AND (reviewed = 0 OR category_id IS NULL) AND source NOT IN ('freshstart', 'cardsync')
      ORDER BY abs(julianday(date) - julianday(?)) LIMIT 3`,
    t.account_id,
    -t.amount,
    t.id,
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
  if (!a || !b) throw new Error('Fant ikke transaksjonen');
  if (a.account_id === b.account_id) throw new Error('En overføring trenger to forskjellige kontoer');
  tx(db, () => {
    // Either side already the half of another transfer: that link goes, so no transaction is left pointing at a
    // half that has moved on (which brought it back to Gjennomgå again and again).
    for (const self of [a, b]) {
      const was = self.transfer_id;
      if (!was || was === a.id || was === b.id) continue;
      const old = get<any>(db, 'SELECT id, source FROM transactions WHERE id = ?', was);
      if (old?.source === 'transfer') run(db, 'DELETE FROM transactions WHERE id = ?', old.id);
      else if (old) run(db, 'UPDATE transactions SET transfer_id = NULL, reviewed = 0 WHERE id = ? AND transfer_id = ?', old.id, self.id);
    }
    run(db, 'UPDATE transactions SET suggested_transfer_id = NULL WHERE suggested_transfer_id IN (?, ?) AND id NOT IN (?, ?)', a.id, b.id, a.id, b.id);
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

/** Splits a transfer back into two ordinary transactions. With `restoreSuggestion` (undo), they go back to
 * being a suggested transfer waiting in Gjennomgå, exactly as before. */
export function unlinkTransfer(db: DB, id: number, restoreSuggestion = false) {
  const t = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', id);
  if (!t?.transfer_id) return;
  const other = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', t.transfer_id);
  tx(db, () => {
    run(db, 'UPDATE transactions SET transfer_id = NULL, reviewed = 0 WHERE id IN (?, ?)', id, t.transfer_id);
    // A counterpart we invented ourselves has no reason to exist anymore.
    if (other?.source === 'transfer') run(db, 'DELETE FROM transactions WHERE id = ?', other.id);
    else if (restoreSuggestion && other) {
      run(db, 'UPDATE transactions SET suggested_transfer_id = ? WHERE id = ?', other.id, id);
      run(db, 'UPDATE transactions SET suggested_transfer_id = ? WHERE id = ?', id, other.id);
    }
  });
}

/** "Nei, ikke en overføring": forget the guess on both sides so it doesn't come back. */
export function rejectTransferSuggestion(db: DB, id: number) {
  const t = get<any>(db, 'SELECT suggested_transfer_id FROM transactions WHERE id = ?', id);
  // Remembered on both, so a sync or a new transfer of the same amount doesn't bring the guess back.
  run(db, 'UPDATE transactions SET suggested_transfer_id = NULL, not_transfer = 1 WHERE id = ?', id);
  run(db, 'UPDATE transactions SET suggested_transfer_id = NULL WHERE suggested_transfer_id = ?', id);
  if (t?.suggested_transfer_id) run(db, 'UPDATE transactions SET suggested_transfer_id = NULL, not_transfer = 1 WHERE id = ?', t.suggested_transfer_id);
}

/** Marks a transaction as a transfer to an account where the other half hasn't shown up yet. */
export function transferToAccount(db: DB, txnId: number, accountId: number): number {
  const t = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', txnId);
  if (!t) throw new Error('Fant ikke transaksjonen');
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
        `Overføring: ${from.name}`,
        t.raw_description,
      ).lastInsertRowid,
    );
  }
  linkTransfer(db, txnId, otherId);
  return otherId;
}

/**
 * Remember a deleted transaction's bank id, so a later sync or re-import doesn't add it again.
 * Call before deleting the row.
 */
export function forgetImport(db: DB, id: number) {
  run(
    db,
    `INSERT INTO forgotten_imports(account_id, external_id, import_hash)
     SELECT account_id, external_id, import_hash FROM transactions WHERE id = ? AND (external_id IS NOT NULL OR import_hash IS NOT NULL)`,
    id,
  );
}

/**
 * Adds transactions to an account, skipping ones already there.
 * `complete` is set for bank syncs: the bank sent every booked transaction from that date, so anything of ours
 * from the same source in that window that the bank no longer lists has had its id changed (see below).
 */
export function ingest(db: DB, accountId: number, incoming: IncomingTxn[], source: string, complete?: { since: string }): IngestResult {
  const result: IngestResult = { added: 0, autoApproved: 0, duplicates: 0, matched: 0, categorized: 0, transfers: 0, ids: [] };
  if (incoming.length === 0) return result;

  // Load everything the checks below need up front: on Cloudflare's free plan each request gets ~10 ms of CPU,
  // so a few bulk reads beat several small queries per transaction.
  const dates = incoming.map((t) => t.date).sort();
  const from = addDays(dates[0], -5);
  const to = addDays(dates[dates.length - 1], 5);
  const externalIds = new Set(
    all<{ v: string }>(
      db,
      `SELECT external_id AS v FROM transactions WHERE account_id = ? AND external_id IS NOT NULL
       UNION SELECT external_id FROM forgotten_imports WHERE account_id = ? AND external_id IS NOT NULL`,
      accountId,
      accountId,
    ).map((r) => r.v),
  );
  const hashes = new Set(
    all<{ v: string }>(
      db,
      `SELECT import_hash AS v FROM transactions WHERE account_id = ? AND import_hash IS NOT NULL
       UNION SELECT import_hash FROM forgotten_imports WHERE account_id = ? AND import_hash IS NOT NULL`,
      accountId,
      accountId,
    ).map((r) => r.v),
  );
  const batchIds = new Set(incoming.map((t) => t.externalId).filter(Boolean));
  // A couple of days of margin: banks don't all filter on the same date field.
  const staleFrom = complete ? addDays(complete.since, 2) : null;
  type Existing = { id: number; amount: number; date: string; source: string; external_id: string | null; import_hash: string | null };
  const existing = all<Existing>(
    db,
    'SELECT id, amount, date, source, external_id, import_hash FROM transactions WHERE account_id = ? AND date BETWEEN ? AND ?',
    accountId,
    from,
    to,
  );
  const suggester = new Suggester(db);
  const ruleHits = new Map<number, number>();
  const touched = new Set<number>();
  const inserted: Array<{ id: number; amount: number; date: string; raw_description: string }> = [];
  const closest = <T extends { date: string }>(list: T[], date: string) =>
    list.sort((a, b) => Math.abs(dayDiff(a.date, date)) - Math.abs(dayDiff(b.date, date)))[0];

  tx(db, () => {
    for (const t of incoming) {
      if ((t.externalId && externalIds.has(t.externalId)) || (t.importHash && hashes.has(t.importHash))) {
        result.duplicates++;
        continue;
      }

      // Something you typed in by hand (or a transfer we created) that the bank is now confirming.
      const manual = closest(
        existing.filter(
          (e) =>
            !touched.has(e.id) && e.amount === t.amount && !e.external_id && !e.import_hash &&
            (e.source === 'manual' || e.source === 'transfer') && Math.abs(dayDiff(e.date, t.date)) <= 5,
        ),
        t.date,
      );
      if (manual) {
        run(
          db,
          'UPDATE transactions SET external_id = ?, import_hash = ?, raw_description = ?, date = ?, source = ? WHERE id = ?',
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

      // The same purchase with a new id from the same bank. Some banks change the id (or the date and text the
      // fallback id is built from) when a purchase goes from reserved to booked, and some send a new id now and
      // then for the same payment. The old copy is no longer in the bank's list, so it's updated in place instead
      // of a second copy being added. Inside the window the bank surely sent, the date may have moved a few days;
      // at its edge (where the bank may not send everything) only the very same day counts.
      const renamed =
        staleFrom &&
        closest(
          existing.filter(
            (e) =>
              !touched.has(e.id) && e.source === source && e.amount === t.amount && !!e.external_id && !batchIds.has(e.external_id) &&
              (e.date >= staleFrom ? Math.abs(dayDiff(e.date, t.date)) <= 4 : e.date === t.date),
          ),
          t.date,
        );
      if (renamed) {
        run(db, 'UPDATE transactions SET external_id = ?, date = ?, raw_description = ? WHERE id = ?', t.externalId ?? null, t.date, t.description, renamed.id);
        // Keep the old id too: if the bank switches back to it, it's known and not added again.
        const old = existing.find((e) => e.id === renamed.id)?.external_id;
        if (old) {
          run(db, 'INSERT INTO forgotten_imports(account_id, external_id) VALUES (?, ?)', accountId, old);
          externalIds.add(old);
        }
        if (t.externalId) externalIds.add(t.externalId);
        touched.add(renamed.id);
        result.matched++;
        continue;
      }

      // The same transaction arriving through a different route (e.g. a CSV covering days already synced).
      // Card purchases can show the purchase date in one and the booking date in the other, so allow a few days.
      const otherRoute = closest(
        existing.filter(
          (e) =>
            !touched.has(e.id) && e.amount === t.amount && !['manual', 'transfer', source].includes(e.source) &&
            Math.abs(dayDiff(e.date, t.date)) <= 4,
        ),
        t.date,
      );
      if (otherRoute) {
        touched.add(otherRoute.id);
        result.duplicates++;
        continue;
      }

      const raw = t.description ?? '';
      const rule = suggester.rule(t.payee ?? cleanPayee(raw), raw, accountId);
      const payee = rule?.rename_to || t.payee || cleanPayee(raw) || raw.slice(0, 80);
      const suggestion = suggester.suggest(payee, raw, t.amount, accountId);
      if (rule) ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1);

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
      if (t.externalId) externalIds.add(t.externalId);
      if (t.importHash) hashes.add(t.importHash);
      touched.add(id);
      inserted.push({ id, amount: t.amount, date: t.date, raw_description: raw });
      result.ids.push(id);
      result.added++;
      if (suggestion) result.categorized++;
    }

    for (const [id, n] of ruleHits) run(db, 'UPDATE rules SET hits = hits + ? WHERE id = ?', n, id);

    // Money coming back for a purchase marked "venter refusjon".
    matchRefunds(db, inserted.map((t) => ({ ...t, payee: undefined })));

    // Transfers: the other half sits in another account with the opposite amount, a few days apart.
    if (result.ids.length) {
      const pool = all<{ id: number; amount: number; date: string; raw_description: string; suggested_transfer_id: number | null }>(
        db,
        `SELECT id, amount, date, raw_description, suggested_transfer_id FROM transactions
          WHERE account_id != ? AND transfer_id IS NULL AND not_transfer = 0 AND (reviewed = 0 OR category_id IS NULL)
            AND source NOT IN ('freshstart', 'cardsync') AND date BETWEEN ? AND ?`,
        accountId,
        addDays(from, -5),
        addDays(to, 5),
      );
      const claimed = new Set<number>();
      for (const t of inserted) {
        const candidates = pool
          .filter((c) => !claimed.has(c.id) && !c.suggested_transfer_id && c.amount === -t.amount && Math.abs(dayDiff(c.date, t.date)) <= 5)
          .sort((a, b) => Math.abs(dayDiff(a.date, t.date)) - Math.abs(dayDiff(b.date, t.date)))
          .slice(0, 3);
        let other = candidates.length === 1 ? candidates[0] : undefined;
        if (candidates.length > 1) {
          const keyword = candidates.filter((c) => TRANSFER_WORDS.test(t.raw_description) || TRANSFER_WORDS.test(c.raw_description));
          if (keyword.length === 1) other = keyword[0];
        }
        if (!other) continue;
        claimed.add(other.id);
        // Always both ways, so the guess is the same from either side.
        run(db, 'UPDATE transactions SET suggested_transfer_id = ? WHERE id = ?', other.id, t.id);
        run(db, 'UPDATE transactions SET suggested_transfer_id = ? WHERE id = ?', t.id, other.id);
        result.transfers++;
      }
    }

    // The ones the app is sure about don't need you: they get their category straight away.
    if (result.ids.length) result.autoApproved = autoApprove(db, { ids: result.ids, suggester });
  });
  return result;
}

/** On unless turned off under Innstillinger. */
export function autoApproveOn(db: DB): boolean {
  return getSetting(db, 'auto_approve') !== 'off';
}

/**
 * Gives transactions waiting in Gjennomgå their suggested category and approves them, when the app is sure (see
 * Suggester.sure). Not transfers or possible transfers, split ones, or anything before the budget start. Limit it to
 * some `ids`, or to one `payee` (after you've categorised one of theirs). Returns how many.
 */
export function autoApprove(db: DB, opts: { ids?: number[]; payee?: string; suggester?: Suggester } = {}): number {
  if (!autoApproveOn(db)) return 0;
  const where = [
    't.reviewed = 0',
    't.category_id IS NULL',
    't.transfer_id IS NULL',
    't.suggested_transfer_id IS NULL',
    "t.source NOT IN ('freshstart', 'cardsync')",
    't.date >= ?',
    'NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)',
  ];
  const params: unknown[] = [getSetting(db, 'budget_start') ?? '0000-01-01'];
  if (opts.payee !== undefined) {
    where.push('lower(t.payee) = lower(?)');
    params.push(opts.payee);
  }
  type Row = { id: number; account_id: number; payee: string; raw_description: string; amount: number; suggested_category_id: number; suggestion_source: string | null };
  const select = `SELECT t.id, t.account_id, t.payee, t.raw_description, t.amount, t.suggested_category_id, t.suggestion_source FROM transactions t WHERE ${where.join(' AND ')}`;
  let rows: Row[] = [];
  if (opts.ids) {
    // Cloudflare's SQLite takes at most 100 parameters per query.
    for (let i = 0; i < opts.ids.length; i += 90) {
      const chunk = opts.ids.slice(i, i + 90);
      rows.push(...all<Row>(db, `${select} AND t.id IN (${chunk.map(() => '?').join(',')})`, ...params, ...chunk));
    }
  } else rows = all<Row>(db, `${select} ORDER BY t.date DESC LIMIT 500`, ...params);
  if (!rows.length) return 0;
  const s = opts.suggester ?? new Suggester(db);
  // A payment that names one of your own accounts ("DNB MC", "Til Sparekonto") is most likely a transfer: ask.
  const norm = (x: string) => ` ${x.toLowerCase().replace(/[^a-zæøå0-9]+/g, ' ').trim()} `;
  const own = all<{ id: number; name: string }>(db, 'SELECT id, name FROM accounts WHERE closed = 0')
    .map((a) => ({ id: a.id, name: norm(a.name) }))
    .filter((a) => a.name.trim().length >= 3);
  const namesOwnAccount = (r: Row) => {
    const text = norm(`${r.payee ?? ''} ${r.raw_description ?? ''}`);
    return own.some((a) => a.id !== r.account_id && text.includes(a.name));
  };
  let n = 0;
  for (const r of rows) {
    if (namesOwnAccount(r)) continue;
    // What the app would suggest now, not when it came in: a payee you've categorised since (or given a fixed
    // category) counts, even if the transaction was stored with an older guess or none.
    const now = s.suggest(r.payee ?? '', r.raw_description ?? '', r.amount, r.account_id);
    const pick =
      now && s.sure(r.payee, r.amount, now.source, now.categoryId)
        ? now
        : s.sure(r.payee, r.amount, r.suggestion_source, r.suggested_category_id)
          ? { categoryId: r.suggested_category_id, source: r.suggestion_source }
          : null;
    if (!pick) continue;
    run(
      db,
      'UPDATE transactions SET category_id = ?, suggested_category_id = ?, suggestion_source = ?, reviewed = 1, auto_approved = 1 WHERE id = ?',
      pick.categoryId,
      pick.categoryId,
      pick.source,
      r.id,
    );
    n++;
  }
  return n;
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
