import { Hono } from 'hono';
import { all, get, getSetting, run, setSetting, tx, type DB } from './db.ts';
import { autoAssign, budgetStart, overspendMode, getBudget, moveMoney, readyToAssign, setAssigned, type AutoAssignMode } from './budget.ts';
import { applyFreshStart, previewFreshStart, undoFreshStart } from './freshstart.ts';
import { forgetImport, ingest, linkTransfer, rejectTransferSuggestion, ruleMatches, transferToAccount, unlinkTransfer, withImportHashes } from './ingest.ts';
import { previewCsv, type CsvMapping } from './import/csv.ts';
import { overview } from './overview.ts';
import { addBill, deleteBill, listBills, syncBillTargets, updateBill, type BillInput } from './bills.ts';
import { dismissDuplicates, findDuplicates, mergeDuplicates } from './duplicates.ts';
import { cashflowReport, detectRecurring, netWorthReport, spendingReport } from './reports.ts';
import { callbackUrl, completeConnection, getProvider, linkAccounts, providers, startConnection, syncAll, syncConnection, providerForState } from './sync/index.ts';
import { addDays, addMonths, currentMonth, todayISO } from '../shared/months.ts';
import { cleanPayee } from './payees.ts';
import { base64ToBytes, bytesToBase64 } from './webcrypto.ts';
import type { PsuContext } from './sync/types.ts';

const MONTH = /^\d{4}-\d{2}$/;

export interface AppConfig {
  /** Shared household password. Empty means no login (fine on your own machine or behind Cloudflare Access). */
  password?: string;
  /** The address the app is opened on; banks redirect back here after BankID. Guessed from the request if empty. */
  publicUrl?: string;
}

let config: AppConfig = {};

function publicUrl(c: any): string {
  if (config.publicUrl) return config.publicUrl;
  const origin = c.req.header('origin');
  if (origin) return origin;
  const proto = c.req.header('x-forwarded-proto') ?? 'http';
  return `${proto}://${c.req.header('x-forwarded-host') ?? c.req.header('host')}`;
}

/** You, at the keyboard: sent to banks so syncs you start yourself don't count against PSD2's daily limit. */
function psuOf(c: any): PsuContext | undefined {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip');
  const userAgent = c.req.header('user-agent');
  return ip && userAgent ? { ip, userAgent } : undefined;
}

function badRequest(message: string): never {
  const e: any = new Error(message);
  e.status = 400;
  throw e;
}

function transactionQuery(where: string) {
  return `
    SELECT t.*, a.name AS account_name, a.kind AS account_kind, c.name AS category_name,
           sc.name AS suggested_category_name,
           ot.account_id AS transfer_account_id, oa.name AS transfer_account_name,
           st.account_id AS suggested_transfer_account_id, sa.name AS suggested_transfer_account_name,
           st.date AS suggested_transfer_date, st.payee AS suggested_transfer_payee,
           (SELECT json_group_array(json_object('id', s.id, 'category_id', s.category_id, 'amount', s.amount, 'memo', s.memo,
                                                'category_name', (SELECT name FROM categories WHERE id = s.category_id)))
              FROM splits s WHERE s.transaction_id = t.id) AS splits_json,
           (SELECT COUNT(*) FROM attachments x WHERE x.transaction_id = t.id) AS attachment_count
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN categories sc ON sc.id = t.suggested_category_id
      LEFT JOIN transactions ot ON ot.id = t.transfer_id
      LEFT JOIN accounts oa ON oa.id = ot.account_id
      LEFT JOIN transactions st ON st.id = t.suggested_transfer_id AND st.transfer_id IS NULL
      LEFT JOIN accounts sa ON sa.id = st.account_id
     WHERE ${where}`;
}

function shapeTxn(r: any) {
  const { splits_json, ...rest } = r;
  const splits = JSON.parse(splits_json ?? '[]');
  return { ...rest, splits };
}

/** Deletes a transaction and what hangs off it. A transfer copy the app made goes too; a bank one is unlinked. */
function deleteTransaction(db: DB, id: number) {
  const t = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', id);
  if (!t) return;
  if (t.transfer_id) {
    const other = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', t.transfer_id);
    if (other?.source === 'transfer') {
      run(db, 'DELETE FROM attachments WHERE transaction_id = ?', other.id);
      run(db, 'DELETE FROM splits WHERE transaction_id = ?', other.id);
      run(db, 'DELETE FROM transactions WHERE id = ?', other.id);
    } else run(db, 'UPDATE transactions SET transfer_id = NULL, reviewed = 0 WHERE id = ?', t.transfer_id);
  }
  run(db, 'UPDATE transactions SET suggested_transfer_id = NULL WHERE suggested_transfer_id = ?', id);
  forgetImport(db, id);
  run(db, 'DELETE FROM attachments WHERE transaction_id = ?', id);
  run(db, 'DELETE FROM splits WHERE transaction_id = ?', id);
  run(db, 'DELETE FROM transactions WHERE id = ?', id);
}

/** After you categorise a payee once, update the other waiting transactions from the same payee. */
function propagate(db: DB, payee: string, categoryId: number, amount: number) {
  run(
    db,
    `UPDATE transactions SET suggested_category_id = ?, suggestion_source = 'history'
      WHERE reviewed = 0 AND payee = ? COLLATE NOCASE AND (amount < 0) = (? < 0)
        AND (suggestion_source IS NULL OR suggestion_source != 'rule')`,
    categoryId,
    payee,
    amount,
  );
}

function rememberRule(db: DB, payee: string, categoryId: number) {
  const existing = get<{ id: number }>(db, "SELECT id FROM rules WHERE match_type = 'equals' AND pattern = ? COLLATE NOCASE", payee);
  if (existing) run(db, 'UPDATE rules SET category_id = ? WHERE id = ?', categoryId, existing.id);
  else run(db, "INSERT INTO rules(match_type, pattern, category_id) VALUES ('equals', ?, ?)", payee, categoryId);
}

export function createApi(db: DB, appConfig: AppConfig = {}) {
  config = appConfig;
  const api = new Hono();

  api.onError((err: any, c) => {
    const status = err.status ?? 500;
    if (status === 500) console.error(err);
    return c.json({ error: err.message ?? 'Noe gikk galt' }, status);
  });

  // ---------- Overview ----------
  api.get('/summary', (c) => {
    const accounts = all<any>(
      db,
      `SELECT a.*, COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id = a.id AND t.date >= ?), 0) AS balance,
              (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.reviewed = 0 AND t.date >= ?) AS unreviewed,
              (SELECT MAX(date) FROM transactions t WHERE t.account_id = a.id) AS last_date,
              (SELECT co.id FROM connection_accounts ca JOIN connections co ON co.id = ca.connection_id WHERE ca.account_id = a.id LIMIT 1) AS connection_id,
              (SELECT co.status FROM connection_accounts ca JOIN connections co ON co.id = ca.connection_id WHERE ca.account_id = a.id LIMIT 1) AS connection_status,
              (SELECT co.last_sync_at FROM connection_accounts ca JOIN connections co ON co.id = ca.connection_id WHERE ca.account_id = a.id LIMIT 1) AS last_sync_at
         FROM accounts a ORDER BY a.closed, a.sort, a.id`,
      budgetStart(db),
      budgetStart(db),
    );
    const attention = all<any>(
      db,
      `SELECT id, name, provider, status, expires_at, last_error FROM connections
        WHERE status IN ('expired', 'error', 'linking') OR (expires_at IS NOT NULL AND expires_at < ?)`,
      addDays(todayISO(), 7),
    );
    return c.json({
      readyToAssign: readyToAssign(db),
      unreviewed: get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM transactions WHERE reviewed = 0 AND date >= ?', budgetStart(db))!.n,
      budgetStart: getSetting(db, 'budget_start') ?? null,
      overspending: overspendMode(db),
      accounts,
      attention,
      categories: all<any>(
        db,
        `SELECT c.id, c.name, c.hidden, g.id AS group_id, g.name AS group_name, g.is_income FROM categories c
           JOIN category_groups g ON g.id = c.group_id ORDER BY g.is_income DESC, g.sort, c.sort, c.id`,
      ),
    });
  });

  // ---------- Budget ----------
  api.get('/budget/:month', (c) => {
    const month = c.req.param('month');
    if (!MONTH.test(month)) badRequest('Måned må se slik ut: 2026-10');
    return c.json(getBudget(db, month));
  });

  api.put('/budget/:month/:categoryId', async (c) => {
    const { amount } = await c.req.json();
    if (!Number.isFinite(amount)) badRequest('Beløpet må være et tall');
    setAssigned(db, c.req.param('month'), Number(c.req.param('categoryId')), amount);
    return c.json(getBudget(db, c.req.param('month')));
  });

  api.post('/budget/:month/auto', async (c) => {
    const { mode, categoryIds } = await c.req.json<{ mode: AutoAssignMode; categoryIds?: number[] }>();
    const result = autoAssign(db, c.req.param('month'), mode, categoryIds);
    return c.json({ ...result, budget: getBudget(db, c.req.param('month')) });
  });

  api.post('/budget/:month/move', async (c) => {
    const { from, to, amount } = await c.req.json<{ from: number | null; to: number | null; amount: number }>();
    if (!(amount > 0)) badRequest('Beløpet må være større enn null');
    moveMoney(db, c.req.param('month'), from, to, amount);
    return c.json(getBudget(db, c.req.param('month')));
  });

  /** Spent and assigned for one category over the last months, for the little chart in the category panel. */
  api.get('/categories/:id/history', (c) => {
    const id = Number(c.req.param('id'));
    const month = c.req.query('month') ?? currentMonth();
    if (!MONTH.test(month)) badRequest('Måned må se slik ut: 2026-10');
    const months = Math.min(12, Math.max(2, Number(c.req.query('months') ?? 6)));
    const first = addMonths(month, -(months - 1));
    const spent = new Map(
      all<{ m: string; v: number }>(
        db,
        `SELECT substr(date, 1, 7) AS m, -SUM(amount) AS v FROM (
           SELECT t.date, t.amount FROM transactions t JOIN accounts a ON a.id = t.account_id
            WHERE a.on_budget = 1 AND t.category_id = ? AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
           UNION ALL
           SELECT t.date, s.amount FROM splits s JOIN transactions t ON t.id = s.transaction_id JOIN accounts a ON a.id = t.account_id
            WHERE a.on_budget = 1 AND s.category_id = ?
         ) WHERE date BETWEEN ? AND ? GROUP BY m`,
        id,
        id,
        `${first}-01`,
        `${month}-31`,
      ).map((r) => [r.m, r.v]),
    );
    const assigned = new Map(
      all<{ month: string; amount: number }>(db, 'SELECT month, amount FROM assignments WHERE category_id = ? AND month BETWEEN ? AND ?', id, first, month).map(
        (r) => [r.month, r.amount],
      ),
    );
    const start = budgetStart(db).slice(0, 7);
    return c.json(
      Array.from({ length: months }, (_, i) => {
        const m = addMonths(first, i);
        // Assigned before "Start på nytt" no longer counts, so it isn't shown either.
        return { month: m, spent: Math.max(0, spent.get(m) ?? 0), assigned: m >= start ? assigned.get(m) ?? 0 : null };
      }),
    );
  });

  // ---------- Categories ----------
  api.get('/categories', (c) =>
    c.json({
      groups: all<any>(db, 'SELECT * FROM category_groups ORDER BY is_income DESC, sort, id').map((g) => ({
        ...g,
        categories: all<any>(db, 'SELECT * FROM categories WHERE group_id = ? ORDER BY sort, id', g.id),
      })),
    }),
  );

  api.post('/category-groups', async (c) => {
    const { name } = await c.req.json();
    if (!name?.trim()) badRequest('Gi gruppen et navn');
    const id = run(db, 'INSERT INTO category_groups(name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM category_groups))', name.trim())
      .lastInsertRowid;
    return c.json({ id: Number(id) });
  });

  api.patch('/category-groups/:id', async (c) => {
    const body = await c.req.json();
    const id = Number(c.req.param('id'));
    if (body.name !== undefined) run(db, 'UPDATE category_groups SET name = ? WHERE id = ?', String(body.name).trim(), id);
    if (body.hidden !== undefined) run(db, 'UPDATE category_groups SET hidden = ? WHERE id = ?', body.hidden ? 1 : 0, id);
    if (body.move) moveSort(db, 'category_groups', id, body.move, 'is_income = (SELECT is_income FROM category_groups WHERE id = ?)', id);
    return c.json({ ok: true });
  });

  api.delete('/category-groups/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (get(db, 'SELECT 1 FROM categories WHERE group_id = ?', id)) badRequest('Flytt eller slett kategoriene i gruppen først');
    run(db, 'DELETE FROM category_groups WHERE id = ?', id);
    return c.json({ ok: true });
  });

  api.post('/categories', async (c) => {
    const { name, group_id } = await c.req.json();
    if (!name?.trim()) badRequest('Gi kategorien et navn');
    const id = run(
      db,
      'INSERT INTO categories(group_id, name, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM categories WHERE group_id = ?))',
      group_id,
      name.trim(),
      group_id,
    ).lastInsertRowid;
    return c.json({ id: Number(id) });
  });

  api.patch('/categories/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    const fields = ['name', 'hidden', 'group_id', 'target_type', 'target_amount', 'target_date', 'note'] as const;
    for (const f of fields) {
      if (body[f] === undefined) continue;
      let value = body[f];
      if (f === 'hidden') value = value ? 1 : 0;
      if (f === 'name') value = String(value).trim();
      if (f === 'target_type' && !['monthly', 'by_date', 'balance', null].includes(value)) badRequest('Ukjent måltype');
      run(db, `UPDATE categories SET ${f} = ? WHERE id = ?`, value, id);
    }
    if (body.move) moveSort(db, 'categories', id, body.move, 'group_id = (SELECT group_id FROM categories WHERE id = ?)', id);
    return c.json({ ok: true });
  });

  api.delete('/categories/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const reassign = c.req.query('reassign') ? Number(c.req.query('reassign')) : null;
    tx(db, () => {
      if (reassign) {
        run(db, 'UPDATE transactions SET category_id = ? WHERE category_id = ?', reassign, id);
        run(db, 'UPDATE splits SET category_id = ? WHERE category_id = ?', reassign, id);
        // Keep the money: move this category's assignments onto the new one.
        for (const a of all<any>(db, 'SELECT * FROM assignments WHERE category_id = ?', id)) {
          const cur = get<{ amount: number }>(db, 'SELECT amount FROM assignments WHERE month = ? AND category_id = ?', a.month, reassign);
          setAssigned(db, a.month, reassign, (cur?.amount ?? 0) + a.amount);
        }
      } else {
        run(db, 'UPDATE transactions SET reviewed = 0 WHERE category_id = ?', id);
      }
      run(db, 'UPDATE transactions SET suggested_category_id = NULL WHERE suggested_category_id = ?', id);
      run(db, 'UPDATE bills SET category_id = ? WHERE category_id = ?', reassign, id);
      syncBillTargets(db, [reassign]);
      run(db, 'DELETE FROM categories WHERE id = ?', id);
    });
    return c.json({ ok: true });
  });

  // ---------- Accounts ----------
  api.post('/accounts', async (c) => {
    const { name, kind = 'checking', on_budget = true, balance = 0, institution = null } = await c.req.json();
    if (!name?.trim()) badRequest('Gi kontoen et navn');
    const id = tx(db, () => {
      const id = Number(
        run(
          db,
          'INSERT INTO accounts(name, kind, institution, on_budget, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts))',
          name.trim(),
          kind,
          institution,
          on_budget ? 1 : 0,
        ).lastInsertRowid,
      );
      if (balance) {
        const incomeCat = get<{ id: number }>(
          db,
          "SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE g.is_income = 1 ORDER BY c.name = 'Annen inntekt' DESC, c.sort LIMIT 1",
        );
        run(
          db,
          `INSERT INTO transactions(account_id, date, amount, payee, raw_description, category_id, reviewed, source)
           VALUES (?, ?, ?, 'Startsaldo', 'Startsaldo', ?, 1, 'manual')`,
          id,
          todayISO(),
          Math.round(balance),
          on_budget ? incomeCat?.id ?? null : null,
        );
      }
      return id;
    });
    return c.json({ id });
  });

  api.patch('/accounts/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    for (const f of ['name', 'kind', 'institution', 'on_budget', 'closed'] as const) {
      if (body[f] === undefined) continue;
      const value = f === 'on_budget' || f === 'closed' ? (body[f] ? 1 : 0) : body[f];
      run(db, `UPDATE accounts SET ${f} = ? WHERE id = ?`, value, id);
    }
    if (body.move) moveSort(db, 'accounts', id, body.move, '1 = 1 OR ? IS NULL', id);
    // Fix the balance so it matches the bank ("reconcile").
    if (body.reconcileTo !== undefined) {
      const bal = get<{ s: number }>(db, 'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ?', id)!.s;
      const diff = Math.round(body.reconcileTo) - bal;
      if (diff !== 0) {
        run(
          db,
          `INSERT INTO transactions(account_id, date, amount, payee, raw_description, reviewed, source)
           VALUES (?, ?, ?, 'Saldojustering', 'Saldojustering', 0, 'manual')`,
          id,
          todayISO(),
          diff,
        );
      }
    }
    return c.json({ ok: true });
  });

  api.delete('/accounts/:id', (c) => {
    const id = Number(c.req.param('id'));
    tx(db, () => {
      // Transfers pointing at this account become normal transactions again.
      run(db, 'UPDATE transactions SET transfer_id = NULL, reviewed = 0 WHERE transfer_id IN (SELECT id FROM transactions WHERE account_id = ?)', id);
      // Explicit deletes: foreign-key cascades aren't guaranteed on every SQLite host.
      run(db, 'DELETE FROM attachments WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)', id);
      run(db, 'DELETE FROM splits WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)', id);
      run(db, 'DELETE FROM pending WHERE account_id = ?', id);
      run(db, 'DELETE FROM forgotten_imports WHERE account_id = ?', id);
      run(db, 'DELETE FROM transactions WHERE account_id = ?', id);
      run(db, 'DELETE FROM accounts WHERE id = ?', id);
    });
    return c.json({ ok: true });
  });

  // ---------- Transactions ----------
  api.get('/transactions', (c) => {
    const q = c.req.query();
    const where: string[] = ['1 = 1'];
    const params: any[] = [];
    if (q.account) {
      where.push('t.account_id = ?');
      params.push(Number(q.account));
    }
    if (q.category === 'none') where.push('t.category_id IS NULL AND t.transfer_id IS NULL AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)');
    else if (q.category) {
      where.push('(t.category_id = ? OR EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id AND s.category_id = ?))');
      params.push(Number(q.category), Number(q.category));
    }
    if (q.month && MONTH.test(q.month)) {
      where.push('t.date BETWEEN ? AND ?');
      params.push(`${q.month}-01`, `${q.month}-31`);
    }
    if (q.review === '1') {
      // Transactions from before a fresh start are history, not something to review.
      where.push('t.reviewed = 0 AND t.date >= ?');
      params.push(budgetStart(db));
    }
    if (q.q) {
      where.push('(t.payee LIKE ? OR t.raw_description LIKE ? OR t.memo LIKE ? OR CAST(abs(t.amount) / 100 AS TEXT) = ?)');
      const like = `%${q.q}%`;
      params.push(like, like, like, q.q.replace(/[^\d]/g, ''));
    }
    const limit = Math.min(Number(q.limit ?? 200), 1000);
    const offset = Number(q.offset ?? 0);
    const rows = all<any>(db, `${transactionQuery(where.join(' AND '))} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions t WHERE ${where.join(' AND ')}`, ...params)!.n;
    return c.json({ transactions: rows.map(shapeTxn), total });
  });

  api.post('/transactions', async (c) => {
    const b = await c.req.json();
    if (!b.account_id || !Number.isFinite(b.amount) || !b.date) badRequest('Konto, dato og beløp må fylles ut');
    const payee = (b.payee ?? '').trim();
    const id = Number(
      run(
        db,
        `INSERT INTO transactions(account_id, date, amount, payee, raw_description, memo, category_id, reviewed, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'manual')`,
        b.account_id,
        b.date,
        Math.round(b.amount),
        payee,
        payee,
        b.memo ?? '',
        b.category_id ?? null,
      ).lastInsertRowid,
    );
    if (b.transfer_account_id) transferToAccount(db, id, b.transfer_account_id);
    return c.json(shapeTxn(get(db, `${transactionQuery('t.id = ?')}`, id)));
  });

  api.patch('/transactions/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await c.req.json();
    const before = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', id);
    if (!before) badRequest('Fant ikke transaksjonen');
    tx(db, () => {
      for (const f of ['date', 'amount', 'payee', 'memo', 'account_id'] as const) {
        if (b[f] !== undefined) run(db, `UPDATE transactions SET ${f} = ? WHERE id = ?`, b[f], id);
      }
      if (b.category_id !== undefined) {
        run(db, 'UPDATE transactions SET category_id = ?, reviewed = 1 WHERE id = ?', b.category_id, id);
        run(db, 'DELETE FROM splits WHERE transaction_id = ?', id);
        if (b.category_id) {
          const payee = b.payee ?? before.payee;
          propagate(db, payee, b.category_id, before.amount);
          if (b.remember) rememberRule(db, payee, b.category_id);
        }
      }
      if (Array.isArray(b.splits)) {
        run(db, 'DELETE FROM splits WHERE transaction_id = ?', id);
        if (b.splits.length > 0) {
          const amount = b.amount ?? before.amount;
          const sum = b.splits.reduce((s: number, x: any) => s + Math.round(x.amount), 0);
          if (sum !== amount) badRequest('Delbeløpene må til sammen bli transaksjonsbeløpet');
          for (const s of b.splits) {
            run(db, 'INSERT INTO splits(transaction_id, category_id, amount, memo) VALUES (?, ?, ?, ?)', id, s.category_id ?? null, Math.round(s.amount), s.memo ?? '');
          }
          run(db, 'UPDATE transactions SET category_id = NULL, reviewed = 1 WHERE id = ?', id);
        }
      }
      if (b.reviewed !== undefined) run(db, 'UPDATE transactions SET reviewed = ? WHERE id = ?', b.reviewed ? 1 : 0, id);
    });
    if (b.reject_transfer) rejectTransferSuggestion(db, id);
    if (b.transfer_account_id === null) unlinkTransfer(db, id, !!b.restore_suggestion);
    else if (b.transfer_account_id) {
      if (before.transfer_id) unlinkTransfer(db, id);
      transferToAccount(db, id, b.transfer_account_id);
    }
    if (b.transfer_id) linkTransfer(db, id, b.transfer_id);
    return c.json(shapeTxn(get(db, transactionQuery('t.id = ?'), id)));
  });

  // ---------- Faste regninger ----------
  // ?light=1 skips the suggestions (the Budsjett page only needs the list).
  api.get('/bills', (c) => c.json(listBills(db, undefined, { suggest: c.req.query('light') !== '1' })));

  api.post('/bills', async (c) => {
    const body = await c.req.json();
    try {
      // One bill, or several at once ("Legg til alle" from the suggestions).
      const ids = (Array.isArray(body) ? body.slice(0, 50) : [body]).map((b: BillInput) => addBill(db, b));
      return c.json({ ids });
    } catch (e: any) {
      badRequest(e.message);
    }
  });

  api.put('/bills/:id', async (c) => {
    try {
      updateBill(db, Number(c.req.param('id')), await c.req.json());
    } catch (e: any) {
      badRequest(e.message);
    }
    return c.json({ ok: true });
  });

  api.delete('/bills/:id', (c) => {
    deleteBill(db, Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // ---------- Duplicates ----------
  api.get('/duplicates', (c) => c.json(findDuplicates(db)));

  api.post('/duplicates/merge', async (c) => {
    const { keep, remove } = await c.req.json<{ keep: number; remove: number[] }>();
    if (!keep || !Array.isArray(remove) || !remove.length) badRequest('Velg hvilken som skal beholdes');
    mergeDuplicates(db, keep, remove.slice(0, 20).map(Number));
    return c.json({ ok: true });
  });

  api.post('/duplicates/dismiss', async (c) => {
    const { key } = await c.req.json<{ key: string }>();
    if (!/^\d+(,\d+)+$/.test(key ?? '')) badRequest('Ugyldig gruppe');
    dismissDuplicates(db, key);
    return c.json({ ok: true });
  });

  // ---------- Attachments (receipts, warranties) ----------
  // Kept as base64 text: a Durable Object row is at most 2 MB, so files are capped at 1.4 MB (images are shrunk in the browser first).
  const MAX_ATTACHMENT = 1_400_000;
  const ATTACHMENT_TYPES = /^(image\/(jpeg|png|webp|gif|heic)|application\/pdf)$/;

  api.get('/transactions/:id/attachments', (c) =>
    c.json(
      all(db, 'SELECT id, name, mime, size, created_at FROM attachments WHERE transaction_id = ? ORDER BY id', Number(c.req.param('id'))),
    ),
  );

  api.post('/transactions/:id/attachments', async (c) => {
    const id = Number(c.req.param('id'));
    if (!get(db, 'SELECT id FROM transactions WHERE id = ?', id)) return c.json({ error: 'Fant ikke transaksjonen' }, 404);
    const mime = (c.req.header('content-type') ?? '').split(';')[0].trim();
    if (!ATTACHMENT_TYPES.test(mime)) badRequest('Bare bilder og PDF kan legges ved');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0) badRequest('Filen er tom');
    if (bytes.length > MAX_ATTACHMENT) badRequest('Filen er for stor (maks 1,4 MB)');
    const name = decodeURIComponent(c.req.header('x-file-name') ?? 'vedlegg').slice(0, 120) || 'vedlegg';
    const res = run(
      db,
      'INSERT INTO attachments (transaction_id, name, mime, size, data) VALUES (?, ?, ?, ?, ?)',
      id,
      name,
      mime,
      bytes.length,
      bytesToBase64(bytes),
    );
    return c.json(get(db, 'SELECT id, name, mime, size, created_at FROM attachments WHERE id = ?', Number(res.lastInsertRowid)));
  });

  api.get('/attachments/:id', (c) => {
    const a = get<any>(db, 'SELECT * FROM attachments WHERE id = ?', Number(c.req.param('id')));
    if (!a) return c.json({ error: 'Fant ikke vedlegget' }, 404);
    return new Response(base64ToBytes(a.data), {
      headers: {
        'Content-Type': a.mime,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  api.delete('/attachments/:id', (c) => {
    run(db, 'DELETE FROM attachments WHERE id = ?', Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  api.delete('/transactions/:id', (c) => {
    tx(db, () => deleteTransaction(db, Number(c.req.param('id'))));
    return c.json({ ok: true });
  });

  /**
   * Several transactions at once (Transaksjoner → Velg): give them a category, mark them as gone through, or delete
   * them. Transfers are left alone when setting a category, since they don't belong in one.
   */
  api.post('/transactions/bulk', async (c) => {
    const b = await c.req.json<{ ids: number[]; action: 'category' | 'reviewed' | 'delete'; category_id?: number | null }>();
    // Cloudflare's SQLite allows at most 100 parameters per query, and each request should stay short.
    const ids = [...new Set((b.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 90);
    if (!ids.length) badRequest('Velg minst én transaksjon');
    let changed = 0;
    let skipped = 0;
    tx(db, () => {
      for (const id of ids) {
        const t = get<any>(db, 'SELECT id, transfer_id, payee, amount FROM transactions WHERE id = ?', id);
        if (!t) continue;
        if (b.action === 'delete') deleteTransaction(db, id);
        else if (b.action === 'reviewed') run(db, 'UPDATE transactions SET reviewed = 1 WHERE id = ?', id);
        else if (b.action === 'category') {
          if (t.transfer_id) {
            skipped++;
            continue;
          }
          run(db, 'UPDATE transactions SET category_id = ?, reviewed = 1 WHERE id = ?', b.category_id ?? null, id);
          run(db, 'DELETE FROM splits WHERE transaction_id = ?', id);
        } else badRequest('Ukjent handling');
        changed++;
      }
    });
    return c.json({ changed, skipped });
  });

  /** "Looks good" for everything that has a suggestion. */
  api.post('/transactions/approve', async (c) => {
    const { ids: given } = await c.req.json<{ ids?: number[] }>().catch(() => ({ ids: undefined }));
    const ids = given?.slice(0, 90); // SQLite on Cloudflare allows at most 100 parameters per query
    // In batches, so one request never runs long (Cloudflare's free plan allows ~10 ms of CPU per request).
    // The app calls again while `more` is true.
    const BATCH = 60;
    const rows = all<any>(
      db,
      `SELECT t.id, t.suggested_category_id, t.suggested_transfer_id, t.payee, t.amount, st.transfer_id AS st_linked
         FROM transactions t LEFT JOIN transactions st ON st.id = t.suggested_transfer_id
        WHERE t.reviewed = 0 AND t.date >= '${budgetStart(db)}' ${
          ids
            ? `AND t.id IN (${ids.map(() => '?').join(',')})`
            : 'AND (t.suggested_category_id IS NOT NULL OR (t.suggested_transfer_id IS NOT NULL AND st.transfer_id IS NULL))'
        }
        ORDER BY t.id LIMIT ${BATCH}`,
      ...(ids ?? []),
    );
    let approved = 0;
    for (const r of rows) {
      const fresh = get<any>(db, 'SELECT reviewed, transfer_id FROM transactions WHERE id = ?', r.id);
      if (fresh.reviewed || fresh.transfer_id) continue; // already handled as the other half of a transfer
      if (r.suggested_transfer_id && r.st_linked === null) {
        linkTransfer(db, r.id, r.suggested_transfer_id);
        approved++;
      } else if (r.suggested_category_id) {
        run(db, 'UPDATE transactions SET category_id = suggested_category_id, reviewed = 1 WHERE id = ?', r.id);
        approved++;
      } else if (ids) {
        run(db, 'UPDATE transactions SET reviewed = 1 WHERE id = ?', r.id);
        approved++;
      }
    }
    return c.json({ approved, more: !ids && rows.length === BATCH });
  });

  // ---------- Rules ----------
  api.get('/rules', (c) =>
    c.json(
      all(
        db,
        `SELECT r.*, c.name AS category_name, a.name AS account_name FROM rules r
           LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN accounts a ON a.id = r.account_id ORDER BY r.pattern COLLATE NOCASE`,
      ),
    ),
  );

  api.post('/rules', async (c) => {
    const b = await c.req.json();
    if (!b.pattern?.trim()) badRequest('Skriv hvilken tekst regelen skal se etter');
    if (b.match_type && !['contains', 'starts', 'equals'].includes(b.match_type)) badRequest('Ukjent regeltype');
    const id = run(
      db,
      'INSERT INTO rules(match_type, pattern, category_id, rename_to, account_id) VALUES (?, ?, ?, ?, ?)',
      b.match_type ?? 'contains',
      b.pattern.trim(),
      b.category_id ?? null,
      b.rename_to?.trim() || null,
      b.account_id ?? null,
    ).lastInsertRowid;
    if (b.apply_existing) applyRuleToWaiting(db, Number(id));
    return c.json({ id: Number(id) });
  });

  api.patch('/rules/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const b = await c.req.json();
    if (!b.pattern?.trim()) badRequest('Skriv hvilken tekst regelen skal se etter');
    if (b.match_type && !['contains', 'starts', 'equals'].includes(b.match_type)) badRequest('Ukjent regeltype');
    run(
      db,
      'UPDATE rules SET match_type = ?, pattern = ?, category_id = ?, rename_to = ?, account_id = ? WHERE id = ?',
      b.match_type ?? 'contains',
      b.pattern.trim(),
      b.category_id ?? null,
      b.rename_to?.trim() || null,
      b.account_id ?? null,
      id,
    );
    if (b.apply_existing) applyRuleToWaiting(db, id);
    return c.json({ ok: true });
  });

  api.delete('/rules/:id', (c) => {
    run(db, 'DELETE FROM rules WHERE id = ?', Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // ---------- CSV import ----------
  api.post('/import/preview', async (c) => {
    const { accountId, text, mapping } = await c.req.json<{ accountId: number; text: string; mapping?: Partial<CsvMapping> }>();
    const account = get<any>(db, 'SELECT * FROM accounts WHERE id = ?', accountId);
    if (!account) badRequest('Velg kontoen du vil importere til');
    const p = previewCsv(text, account.kind, mapping);
    const hashed = withImportHashes(p.rows);
    const dupes = hashed.filter((r) => get(db, 'SELECT 1 FROM transactions WHERE account_id = ? AND import_hash = ?', accountId, r.importHash)).length;
    const dates = p.rows.map((r) => r.date).sort();
    return c.json({
      format: p.format,
      headers: p.headers,
      sample: p.sample,
      mapping: p.mapping,
      warnings: p.warnings,
      count: p.rows.length,
      skipped: p.skipped,
      alreadyImported: dupes,
      from: dates[0],
      to: dates[dates.length - 1],
      inflow: p.rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0),
      outflow: p.rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0),
      preview: p.rows.slice(0, 8).map((r) => ({ ...r, payee: cleanPayee(r.description) })),
    });
  });

  api.post('/import/commit', async (c) => {
    const { accountId, text, mapping, offset = 0, limit = 80 } = await c.req.json<{
      accountId: number;
      text: string;
      mapping: Partial<CsvMapping>;
      offset?: number;
      limit?: number;
    }>();
    const account = get<any>(db, 'SELECT * FROM accounts WHERE id = ?', accountId);
    if (!account) badRequest('Velg kontoen du vil importere til');
    const p = previewCsv(text, account.kind, mapping);
    // Fingerprints are computed over the whole file, then imported a slice at a time; the app sends the next
    // offset until `next` is null. Keeps each request small enough for Cloudflare's free plan.
    const rows = withImportHashes(p.rows);
    const result = ingest(db, accountId, rows.slice(offset, offset + limit), 'csv');
    const next = offset + limit < rows.length ? offset + limit : null;
    return c.json({ ...result, total: rows.length, next });
  });

  // ---------- Bank connections ----------
  api.get('/connections', (c) =>
    c.json(
      all<any>(db, 'SELECT id, provider, name, status, data, expires_at, last_sync_at, last_error, created_at FROM connections ORDER BY id').map((conn) => {
        const data = JSON.parse(conn.data);
        return {
          ...conn,
          data: undefined,
          providerLabel: providers[conn.provider]?.label ?? conn.provider,
          discovered: data.discovered ?? [],
          bankId: data.bank ?? null,
          accounts: all(
            db,
            `SELECT ca.*, a.name AS account_name FROM connection_accounts ca LEFT JOIN accounts a ON a.id = ca.account_id WHERE ca.connection_id = ?`,
            conn.id,
          ),
        };
      }),
    ),
  );

  api.get('/banks/:provider', async (c) => {
    const p = getProvider(c.req.param('provider'));
    if (!p.listBanks) return c.json([]);
    return c.json(await p.listBanks(db, c.req.query('country')));
  });

  api.post('/connections/start', async (c) => {
    const { provider, bankId, reconnectId } = await c.req.json();
    const url = await startConnection(db, { providerId: provider, bankId, reconnectId, publicUrl: publicUrl(c) });
    return c.json({ url });
  });

  const bankCallback = async (c: any, providerId: string | undefined) => {
    const base = config.publicUrl ?? '';
    const { code, state, error, error_description } = c.req.query();
    if (error || !code || !state || !providerId) {
      return c.redirect(`${base}/accounts?bankError=${encodeURIComponent(error_description ?? error ?? 'Bankinnloggingen ble avbrutt')}`);
    }
    try {
      const pub = config.publicUrl || new URL(c.req.url).origin;
      const r = await completeConnection(db, providerId, code, state, pub);
      if (!r.needsLinking) await syncConnection(db, r.id, undefined, psuOf(c)).catch(() => undefined);
      return c.redirect(`${base}/accounts?${r.needsLinking ? 'link' : 'synced'}=${r.id}`);
    } catch (e: any) {
      return c.redirect(`${base}/accounts?bankError=${encodeURIComponent(e.message)}`);
    }
  };
  api.get('/connections/callback/:provider', (c) => bankCallback(c, c.req.param('provider')));
  // Banks that return to the front page (SpareBank 1) are forwarded here by the web app; the state says which bank.
  api.get('/connections/callback', (c) => bankCallback(c, providerForState(db, c.req.query('state') ?? '')));

  api.post('/connections/:id/link', async (c) => {
    const id = Number(c.req.param('id'));
    const { choices } = await c.req.json();
    linkAccounts(db, id, choices);
    // The app then syncs each account in its own request (see /connections/:id/sync?account=).
    const accounts = all<{ remote_id: string }>(db, 'SELECT remote_id FROM connection_accounts WHERE connection_id = ? AND account_id IS NOT NULL', id);
    return c.json({ accounts: accounts.map((a) => a.remote_id) });
  });

  // `?account=<remote id>` syncs a single account, so a first sync of many accounts can be split into small requests.
  api.post('/connections/:id/sync', async (c) =>
    c.json(await syncConnection(db, Number(c.req.param('id')), c.req.query('account') || undefined, psuOf(c))),
  );
  api.post('/connections/sync-all', async (c) => c.json(await syncAll(db, psuOf(c))));

  api.delete('/connections/:id', (c) => {
    run(db, 'DELETE FROM connections WHERE id = ?', Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // ---------- Settings ----------
  api.get('/settings', (c) =>
    c.json({
      publicUrl: publicUrl(c),
      passwordEnabled: !!config.password,
      providers: Object.values(providers).map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        configured: p.isConfigured(db),
        callbackUrl: callbackUrl(publicUrl(c), p.id),
        settings: p.settings.map((s) => ({
          ...s,
          isSet: !!getSetting(db, s.key),
          value: s.secret ? undefined : getSetting(db, s.key) ?? '',
        })),
      })),
    }),
  );

  api.put('/settings', async (c) => {
    const body = await c.req.json<Record<string, string | null>>();
    const allowed = new Set([...Object.values(providers).flatMap((p) => p.settings.map((s) => s.key)), 'overspending']);
    for (const [k, v] of Object.entries(body)) {
      if (!allowed.has(k)) continue;
      setSetting(db, k, typeof v === 'string' ? v.trim() : null);
    }
    return c.json({ ok: true });
  });

  // ---------- Reports ----------
  api.get('/reports/spending', (c) => c.json(spendingReport(db, c.req.query('month') ?? currentMonth())));
  api.get('/reports/cashflow', (c) => c.json(cashflowReport(db, Number(c.req.query('months') ?? 12))));
  api.get('/reports/networth', (c) => c.json(netWorthReport(db, Number(c.req.query('months') ?? 12))));
  api.get('/recurring', (c) => c.json(detectRecurring(db)));
  /** Monthly wrap-up: how a finished month went, and what's left over that could go to savings. */
  api.get('/wrapup', (c) => {
    const month = c.req.query('month') ?? addMonths(currentMonth(), -1);
    if (!MONTH.test(month)) badRequest('Måned må se slik ut: 2026-10');
    const o = overview(db, month, 1);
    const b = getBudget(db, month);
    const now = getBudget(db, currentMonth());
    const groupOf = new Map(b.groups.flatMap((g) => g.categories.map((c) => [c.id, g.name] as const)));
    const isSavings = (c: { id: number; target_type: string | null }) =>
      c.target_type === 'balance' || c.target_type === 'by_date' || /spar|buffer/i.test(groupOf.get(c.id) ?? '');
    const cats = b.groups.flatMap((g) => g.categories).filter((c) => !c.hidden);
    // Leftovers are judged on what's still there now, since that's what can be moved.
    const nowById = new Map(now.groups.flatMap((g) => g.categories).map((c) => [c.id, c]));
    return c.json({
      month,
      income: o.income,
      spending: o.spending,
      prevSpending: o.prevSpending,
      top: o.groups
        .flatMap((g) => g.categories)
        .filter((c) => c.id !== null)
        .sort((x, y) => y.spent - x.spent)
        .slice(0, 3)
        .map((c) => ({ name: c.name, spent: c.spent, prevSpent: c.prevSpent })),
      overspent: cats.filter((c) => c.available < 0).map((c) => ({ id: c.id, name: c.name, amount: -c.available })),
      leftovers: cats
        .filter((c) => !isSavings(c) && c.available > 0 && (nowById.get(c.id)?.available ?? 0) > 0)
        .map((c) => ({ id: c.id, name: c.name, amount: Math.min(c.available, nowById.get(c.id)!.available) })),
      savings: cats.filter(isSavings).map((c) => ({ id: c.id, name: c.name })),
    });
  });

  api.get('/pending', (c) => {
    const account = c.req.query('account');
    return c.json(
      all(
        db,
        `SELECT p.*, a.name AS account_name FROM pending p JOIN accounts a ON a.id = p.account_id
          ${account ? 'WHERE p.account_id = ?' : ''} ORDER BY p.date DESC, p.id DESC`,
        ...(account ? [Number(account)] : []),
      ),
    );
  });

  // ---------- Start på nytt ----------
  api.get('/fresh-start/preview', (c) => {
    const month = c.req.query('month') ?? currentMonth();
    if (!MONTH.test(month)) badRequest('Måned må se slik ut: 2026-11');
    return c.json({ start: getSetting(db, 'budget_start') ?? null, accounts: previewFreshStart(db, `${month}-01`) });
  });
  api.post('/fresh-start', async (c) => {
    const { month, overrides } = await c.req.json<{ month: string; overrides?: Record<string, number> }>();
    if (!MONTH.test(month ?? '')) badRequest('Velg en måned å starte fra');
    const o = Object.fromEntries(Object.entries(overrides ?? {}).map(([k, v]) => [Number(k), Math.round(Number(v))]));
    return c.json({ accounts: applyFreshStart(db, `${month}-01`, o) });
  });
  api.delete('/fresh-start', (c) => {
    undoFreshStart(db);
    return c.json({ ok: true });
  });
  api.get('/overview', (c) => {
    const month = c.req.query('month') ?? currentMonth();
    if (!MONTH.test(month)) badRequest('Måned må se slik ut: 2026-10');
    const span = Math.min(24, Math.max(1, Number(c.req.query('span') ?? 1) || 1));
    return c.json(overview(db, month, span));
  });

  return api;
}

function moveSort(db: DB, table: string, id: number, direction: 'up' | 'down', scope: string, scopeParam: number) {
  const items = all<{ id: number }>(db, `SELECT id FROM ${table} WHERE ${scope} ORDER BY sort, id`, scopeParam);
  const i = items.findIndex((x) => x.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  tx(db, () => items.forEach((x, idx) => run(db, `UPDATE ${table} SET sort = ? WHERE id = ?`, idx, x.id)));
}

function applyRuleToWaiting(db: DB, ruleId: number) {
  const rule = get<any>(db, 'SELECT * FROM rules WHERE id = ?', ruleId);
  if (!rule) return;
  const waiting = all<any>(db, 'SELECT id, payee, raw_description, account_id FROM transactions WHERE reviewed = 0');
  for (const t of waiting) {
    const hit = ruleMatches(rule, t.payee, t.raw_description, t.account_id);
    if (!hit) continue;
    if (rule.rename_to) run(db, 'UPDATE transactions SET payee = ? WHERE id = ?', rule.rename_to, t.id);
    if (rule.category_id) run(db, "UPDATE transactions SET suggested_category_id = ?, suggestion_source = 'rule' WHERE id = ?", rule.category_id, t.id);
  }
}
