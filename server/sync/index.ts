import { all, get, getSetting, run, tx, type DB } from '../db.ts';
import { addFreshStartOpening, followBankAfterFreshStart } from '../freshstart.ts';
import { ingest, type IngestResult } from '../ingest.ts';
import { cleanPayee } from '../payees.ts';
import { addDays, todayISO } from '../../shared/months.ts';
import { enableBanking } from './enablebanking.ts';
import { sparebank1 } from './sparebank1.ts';
import { randomHex } from '../webcrypto.ts';
import { ReauthRequired, type Provider, type PsuContext } from './types.ts';

export const providers: Record<string, Provider> = {
  [enableBanking.id]: enableBanking,
  [sparebank1.id]: sparebank1,
};

export function getProvider(id: string): Provider {
  const p = providers[id];
  if (!p) throw new Error(`Ukjent bankleverandør: ${id}`);
  return p;
}

export const callbackUrl = (publicUrl: string, providerId: string) =>
  `${publicUrl.replace(/\/$/, '')}${getProvider(providerId).redirectPath ?? `/api/connections/callback/${providerId}`}`;

/** Which provider a BankID round trip belongs to, for banks that return to the app's front page. */
export function providerForState(db: DB, state: string): string | undefined {
  return get<{ provider: string }>(db, 'SELECT provider FROM pending_auth WHERE state = ?', state)?.provider;
}

export async function startConnection(
  db: DB,
  opts: { providerId: string; bankId?: string; publicUrl: string; reconnectId?: number },
): Promise<string> {
  const provider = getProvider(opts.providerId);
  if (!provider.isConfigured(db)) throw new Error(`${provider.label} er ikke satt opp ennå. Legg inn API-nøklene under Innstillinger først.`);
  const state = randomHex(16);
  const result = await provider.start(db, {
    bankId: opts.bankId,
    redirectUrl: callbackUrl(opts.publicUrl, provider.id),
    state,
  });
  run(db, "DELETE FROM pending_auth WHERE created_at < datetime('now', '-1 day')");
  run(
    db,
    'INSERT INTO pending_auth(state, provider, data) VALUES (?, ?, ?)',
    state,
    provider.id,
    JSON.stringify({ ...result.pending, reconnectId: opts.reconnectId }),
  );
  return result.url;
}

/** Called when the bank redirects back after BankID. Returns the connection that now needs account linking. */
export async function completeConnection(db: DB, providerId: string, code: string, state: string, publicUrl: string) {
  const pending = get<{ provider: string; data: string }>(db, 'SELECT * FROM pending_auth WHERE state = ?', state);
  if (!pending || pending.provider !== providerId) throw new Error('Denne bankinnloggingen har utløpt. Start på nytt.');
  run(db, 'DELETE FROM pending_auth WHERE state = ?', state);
  const pendingData = JSON.parse(pending.data);
  const provider = getProvider(providerId);
  const result = await provider.complete(db, { code, state, redirectUrl: callbackUrl(publicUrl, providerId), pending: pendingData });

  return tx(db, () => {
    let id: number = pendingData.reconnectId;
    const previous = new Map<string, number | null>();
    if (id && get(db, 'SELECT 1 FROM connections WHERE id = ?', id)) {
      // Reconnecting: banks may hand out new account IDs, so re-match the old links by name.
      for (const r of all<any>(db, 'SELECT * FROM connection_accounts WHERE connection_id = ?', id)) {
        previous.set(r.remote_name, r.account_id);
        previous.set(r.remote_id, r.account_id);
      }
      run(db, 'DELETE FROM connection_accounts WHERE connection_id = ?', id);
      run(
        db,
        "UPDATE connections SET data = ?, expires_at = ?, status = 'linking', last_error = NULL WHERE id = ?",
        JSON.stringify(result.data),
        result.expiresAt ?? null,
        id,
      );
    } else {
      id = Number(
        run(
          db,
          "INSERT INTO connections(provider, name, status, data, expires_at) VALUES (?, ?, 'linking', ?, ?)",
          providerId,
          result.name,
          JSON.stringify(result.data),
          result.expiresAt ?? null,
        ).lastInsertRowid,
      );
    }
    let allMatched = previous.size > 0;
    for (const a of result.accounts) {
      const label = remoteLabel(a);
      const accountId = previous.get(a.remoteId) ?? previous.get(label) ?? null;
      if (!accountId) allMatched = false;
      run(
        db,
        'INSERT INTO connection_accounts(connection_id, remote_id, remote_name, account_id) VALUES (?, ?, ?, ?)',
        id,
        a.remoteId,
        label,
        accountId,
      );
    }
    // Stash what the bank told us so the linking screen can suggest names and account types.
    run(db, 'UPDATE connections SET data = json_set(data, \'$.discovered\', json(?)) WHERE id = ?', JSON.stringify(result.accounts), id);
    if (allMatched) run(db, "UPDATE connections SET status = 'active' WHERE id = ?", id);
    return { id, needsLinking: !allMatched };
  });
}

function remoteLabel(a: { name: string; iban?: string }) {
  return a.iban ? `${a.name} (${a.iban.slice(-4)})` : a.name;
}

export interface LinkChoice {
  remoteId: string;
  accountId?: number | null; // existing account, or null to skip
  create?: { name: string; kind: string; onBudget: boolean };
}

export function linkAccounts(db: DB, connectionId: number, choices: LinkChoice[]) {
  tx(db, () => {
    for (const c of choices) {
      let accountId = c.accountId ?? null;
      if (c.create) {
        const conn = get<{ name: string }>(db, 'SELECT name FROM connections WHERE id = ?', connectionId)!;
        accountId = Number(
          run(
            db,
            'INSERT INTO accounts(name, kind, institution, on_budget, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts))',
            c.create.name,
            c.create.kind,
            conn.name,
            c.create.onBudget ? 1 : 0,
          ).lastInsertRowid,
        );
      }
      run(db, 'UPDATE connection_accounts SET account_id = ? WHERE connection_id = ? AND remote_id = ?', accountId, connectionId, c.remoteId);
    }
    run(db, "UPDATE connections SET status = 'active' WHERE id = ?", connectionId);
  });
}

export async function syncConnection(
  db: DB,
  connectionId: number,
  onlyRemoteId?: string,
  psu?: PsuContext,
): Promise<IngestResult & { errors: string[] }> {
  const conn = get<any>(db, 'SELECT * FROM connections WHERE id = ?', connectionId);
  if (!conn) throw new Error('Fant ikke bankkoblingen');
  const provider = getProvider(conn.provider);
  const total: IngestResult & { errors: string[] } = { added: 0, duplicates: 0, matched: 0, categorized: 0, transfers: 0, ids: [], errors: [] };
  let data = JSON.parse(conn.data);
  const links = all<any>(db, 'SELECT * FROM connection_accounts WHERE connection_id = ? AND account_id IS NOT NULL', connectionId).filter(
    (l) => !onlyRemoteId || l.remote_id === onlyRemoteId,
  );

  for (const link of links) {
    // Re-read a few days back every time: banks sometimes book transactions late.
    const last = get<{ d: string }>(
      db,
      'SELECT MAX(date) AS d FROM transactions WHERE account_id = ? AND source = ?',
      link.account_id,
      conn.provider,
    )?.d;
    const since = last ? addDays(last, -7) : addDays(todayISO(), -90);
    try {
      const result = await provider.fetch(db, data, link.remote_id, since, psu);
      if (result.data) {
        data = { ...data, ...result.data };
        run(db, 'UPDATE connections SET data = ? WHERE id = ?', JSON.stringify(data), connectionId);
      }
      const r = ingest(db, link.account_id, result.transactions, conn.provider);
      if (result.pending) replacePending(db, link.account_id, result.pending);
      for (const k of ['added', 'duplicates', 'matched', 'categorized', 'transfers'] as const) total[k] += r[k];
      total.ids.push(...r.ids);
      if (result.balance !== undefined) {
        run(db, "UPDATE accounts SET bank_balance = ?, bank_balance_at = datetime('now') WHERE id = ?", result.balance, link.account_id);
        if (!last) seedOpeningBalance(db, link.account_id, result.balance);
        else followBankAfterFreshStart(db, link.account_id);
      }
    } catch (e: any) {
      if (e instanceof ReauthRequired) {
        run(db, "UPDATE connections SET status = 'expired', last_error = ? WHERE id = ?", e.message, connectionId);
        throw e;
      }
      total.errors.push(`${link.remote_name}: ${e.message}`);
    }
  }
  if (provider.id === 'sparebank1' && data.refresh_expires_at) {
    run(db, 'UPDATE connections SET expires_at = ? WHERE id = ?', data.refresh_expires_at, connectionId);
  }
  run(
    db,
    "UPDATE connections SET last_sync_at = datetime('now'), last_error = ?, status = CASE WHEN status = 'linking' THEN status ELSE 'active' END WHERE id = ?",
    total.errors.length ? total.errors.join('\n') : null,
    connectionId,
  );
  return total;
}

/**
 * On first sync the bank only gives ~90 days of history, but the account balance is the full truth.
 * Add a "Starting balance" so the app's balance matches the bank from day one.
 */
export function seedOpeningBalance(db: DB, accountId: number, bankBalance: number) {
  // After a fresh start, a newly linked account starts like the others: one opening on the start date.
  if (getSetting(db, 'budget_start')) {
    addFreshStartOpening(db, accountId);
    return;
  }
  const sum = get<{ s: number; first: string | null }>(db, 'SELECT COALESCE(SUM(amount), 0) AS s, MIN(date) AS first FROM transactions WHERE account_id = ?', accountId)!;
  const diff = bankBalance - sum.s;
  if (diff === 0) return;
  const acc = get<{ on_budget: number }>(db, 'SELECT on_budget FROM accounts WHERE id = ?', accountId)!;
  const incomeCat = get<{ id: number }>(
    db,
    "SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE g.is_income = 1 ORDER BY c.name = 'Annen inntekt' DESC, c.sort LIMIT 1",
  );
  run(
    db,
    `INSERT INTO transactions(account_id, date, amount, payee, raw_description, category_id, reviewed, source)
     VALUES (?, ?, ?, 'Startsaldo', 'Startsaldo', ?, 1, 'manual')`,
    accountId,
    addDays(sum.first ?? todayISO(), -1),
    diff,
    acc.on_budget ? incomeCat?.id ?? null : null,
  );
}

/** Reserved card purchases: shown so you see them right away, replaced wholesale on every sync. */
export function replacePending(db: DB, accountId: number, pending: Array<{ date: string; amount: number; description: string; payee?: string }>) {
  tx(db, () => {
    run(db, 'DELETE FROM pending WHERE account_id = ?', accountId);
    for (const p of pending) {
      run(
        db,
        'INSERT INTO pending(account_id, date, amount, payee, description) VALUES (?, ?, ?, ?, ?)',
        accountId,
        p.date,
        p.amount,
        p.payee || cleanPayee(p.description),
        p.description,
      );
    }
  });
}

/** Syncs every bank. Without `psu` it's a background sync (the scheduled one). */
export async function syncAll(db: DB, psu?: PsuContext) {
  const conns = all<{ id: number; name: string }>(db, "SELECT id, name FROM connections WHERE status IN ('active', 'error')");
  const results: Array<{ id: number; name: string; added?: number; error?: string }> = [];
  for (const c of conns) {
    try {
      const r = await syncConnection(db, c.id, undefined, psu);
      results.push({ id: c.id, name: c.name, added: r.added });
    } catch (e: any) {
      if (!(e instanceof ReauthRequired)) run(db, "UPDATE connections SET status = 'error', last_error = ? WHERE id = ?", e.message, c.id);
      results.push({ id: c.id, name: c.name, error: e.message });
    }
  }
  return results;
}
