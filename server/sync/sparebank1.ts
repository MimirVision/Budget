/**
 * SpareBank 1 "Personlig klient" — SpareBank 1's own free API for reading your own accounts.
 * Register at https://developer.sparebank1.no (Personlig klient), set the redirect URL to
 * <PUBLIC_URL>/api/connections/callback/sparebank1, and paste client ID, secret and your bank's
 * finInst ID (listed on the same page, e.g. "fid-smn") into Settings.
 *
 * Access tokens last 10 minutes; the refresh token lasts 30 days and is renewed every sync, so as long as
 * the app syncs at least once a month you never need to log in again.
 */
import { getSetting, type DB } from '../db.ts';
import { stableId } from '../webcrypto.ts';
import { ReauthRequired, toOre, type Provider, type RemoteTxn } from './types.ts';

const AUTH = 'https://api-auth.sparebank1.no';
const API = 'https://api.sparebank1.no';
const ACCEPT = 'application/vnd.sparebank1.v1+json; charset=utf-8';

async function token(db: DB, form: Record<string, string>) {
  const res = await fetch(`${AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: getSetting(db, 'sparebank1_client_id') ?? '',
      client_secret: getSetting(db, 'sparebank1_client_secret') ?? '',
      ...form,
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (form.grant_type === 'refresh_token') throw new ReauthRequired('SpareBank 1-innloggingen har utløpt. Koble til på nytt med BankID.');
    throw new Error(json.error_description ?? json.error ?? `Innlogging hos SpareBank 1 feilet (${res.status})`);
  }
  return {
    access_token: json.access_token as string,
    refresh_token: (json.refresh_token as string) ?? form.refresh_token,
    expires_at: new Date(Date.now() + (json.expires_in ?? 600) * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + (json.refresh_token_expires_in ?? 30 * 86400) * 1000).toISOString(),
  };
}

async function api(path: string, accessToken: string) {
  // SpareBank 1's own sample sends the version as Content-Type even on GET, so send it both ways.
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: ACCEPT, 'Content-Type': ACCEPT } });
  if (res.status === 401) throw new ReauthRequired('SpareBank 1-innloggingen har utløpt. Koble til på nytt med BankID.');
  if (!res.ok) throw new Error(`Feil fra SpareBank 1 (${res.status}): ${await res.text()}`);
  return res.json() as Promise<any>;
}

function osloDate(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(new Date(value));
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (typeof value === 'string' && /^\d{2}\.\d{2}\.\d{4}/.test(value)) {
    const [d, m, y] = value.slice(0, 10).split('.');
    return `${y}-${m}-${d}`;
  }
  return undefined;
}

function num(v: any): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'amount' in v) return Number(v.amount);
  return Number(String(v ?? '0').replace(/\s/g, '').replace(',', '.'));
}

export const sparebank1: Provider = {
  id: 'sparebank1',
  label: 'SpareBank 1 (direkte)',
  description: 'SpareBank 1 sitt eget gratis API. Fungerer bare for SpareBank 1-banker, som SpareBank 1 Sør-Norge.',
  settings: [
    { key: 'sparebank1_client_id', label: 'Klient-ID', help: 'Fra developer.sparebank1.no → Personlig klient.' },
    { key: 'sparebank1_client_secret', label: 'Klienthemmelighet', secret: true },
    {
      key: 'sparebank1_fininst',
      label: 'Bank-ID (finInst)',
      help: 'Står som «Financial institution» på klienten din, f.eks. «fid-sor-norge».',
    },
  ],

  isConfigured: (db) =>
    !!getSetting(db, 'sparebank1_client_id') && !!getSetting(db, 'sparebank1_client_secret') && !!getSetting(db, 'sparebank1_fininst'),

  async start(db, { redirectUrl, state }) {
    const qs = new URLSearchParams({
      client_id: getSetting(db, 'sparebank1_client_id') ?? '',
      state,
      redirect_uri: redirectUrl,
      finInst: getSetting(db, 'sparebank1_fininst') ?? '',
      response_type: 'code',
    });
    return { url: `${AUTH}/oauth/authorize?${qs}` };
  },

  async complete(db, { code, redirectUrl }) {
    // Their sample code names the field redirect_url; standard OAuth says redirect_uri. Send both.
    const t = await token(db, { grant_type: 'authorization_code', code, redirect_uri: redirectUrl, redirect_url: redirectUrl });
    const json = await api('/personal/banking/accounts', t.access_token);
    const list: any[] = json.accounts ?? json.list ?? (Array.isArray(json) ? json : []);
    return {
      name: 'SpareBank 1',
      data: t,
      expiresAt: t.refresh_expires_at,
      accounts: list.map((a) => ({
        remoteId: a.key ?? a.accountKey ?? a.id,
        name: a.name ?? a.description ?? a.accountNumber,
        iban: a.iban,
        currency: a.currencyCode ?? 'NOK',
        kind: /kreditt|credit/i.test(`${a.type} ${a.name}`) ? 'credit' : /spar|saving|bsu/i.test(`${a.type} ${a.name}`) ? 'savings' : 'checking',
        balance: a.balance !== undefined ? toOre(num(a.balance)) : undefined,
      })),
    };
  },

  async fetch(db, data, remoteId, since) {
    let t = data as any;
    if (!t.access_token || !t.expires_at || Date.parse(t.expires_at) < Date.now() + 30_000) {
      t = await token(db, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
    }
    const qs = new URLSearchParams({ accountKey: remoteId, fromDate: since });
    const json = await api(`/personal/banking/transactions?${qs}`, t.access_token);
    const list: any[] = json.transactions ?? json.list ?? [];
    const transactions: RemoteTxn[] = [];
    for (const x of list) {
      if (x.bookingStatus && x.bookingStatus !== 'BOOKED') continue;
      const date = osloDate(x.date ?? x.bookingDate ?? x.accountingDate ?? x.valueDate);
      if (!date) continue;
      const amount = toOre(num(x.amount));
      const description = String(x.description ?? x.cleanedDescription ?? x.reference ?? '').trim();
      transactions.push({
        externalId:
          String(x.id ?? x.transactionId ?? '') ||
          stableId(JSON.stringify([date, amount, description, x.nonUniqueId ?? ''])),
        date,
        amount,
        description,
        payee: x.cleanedDescription || x.remoteAccountName || undefined,
      });
    }
    let balance: number | undefined;
    try {
      const acc = await api(`/personal/banking/accounts/${encodeURIComponent(remoteId)}`, t.access_token);
      if (acc.balance !== undefined) balance = toOre(num(acc.balance));
    } catch {
      // Balance is optional.
    }
    return { transactions, balance, data: t };
  },
};
