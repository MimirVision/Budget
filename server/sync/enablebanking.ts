/**
 * Enable Banking (https://enablebanking.com) — one PSD2 aggregator for DNB, SpareBank 1, Revolut and most
 * other European banks. Create an application in their control panel (restricted/personal mode lets you link
 * your own accounts for free), download the private key, and paste the application ID + key into Settings.
 */
import crypto from 'node:crypto';
import { getSetting, type DB } from '../db.ts';
import { todayISO } from '../../shared/months.ts';
import { ReauthRequired, toOre, type Provider, type RemoteTxn } from './types.ts';

const API = 'https://api.enablebanking.com';

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function jwt(db: DB): string {
  const appId = getSetting(db, 'enablebanking_app_id');
  const key = getSetting(db, 'enablebanking_private_key');
  if (!appId || !key) throw new Error('Enable Banking is not set up yet. Add the application ID and private key in Settings.');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId }));
  const payload = b64url(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${b64url(signature)}`;
}

async function call(db: DB, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt(db)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (res.status === 401 || res.status === 403 || json?.error === 'EXPIRED_SESSION') {
    throw new ReauthRequired(json?.message ?? 'The bank connection has expired. Reconnect with BankID.');
  }
  if (!res.ok) throw new Error(json?.message ?? json?.detail ?? `Enable Banking error ${res.status}`);
  return json;
}

function kindFromName(name = ''): 'checking' | 'savings' | 'credit' {
  if (/kreditt|credit|card|kort|mastercard|visa/i.test(name)) return 'credit';
  if (/spar|saving|høyrente|bsu/i.test(name)) return 'savings';
  return 'checking';
}

export const enableBanking: Provider = {
  id: 'enablebanking',
  label: 'Enable Banking',
  description: 'Connects DNB, SpareBank 1, Revolut and most Norwegian and European banks through BankID.',
  settings: [
    { key: 'enablebanking_app_id', label: 'Application ID', help: 'From the Enable Banking control panel → Applications.' },
    {
      key: 'enablebanking_private_key',
      label: 'Private key (.pem)',
      secret: true,
      multiline: true,
      help: 'The private key file you downloaded when creating the application.',
    },
  ],

  isConfigured: (db) => !!getSetting(db, 'enablebanking_app_id') && !!getSetting(db, 'enablebanking_private_key'),

  async listBanks(db) {
    const json = await call(db, 'GET', '/aspsps?country=NO&psu_type=personal');
    return (json.aspsps ?? []).map((a: any) => ({ id: a.name, name: a.name, logo: a.logo }));
  },

  async start(db, { bankId, redirectUrl, state }) {
    if (!bankId) throw new Error('Pick a bank first');
    // Banks allow at most 180 days before you have to confirm again with BankID; ask for the maximum.
    const validUntil = new Date(Date.now() + 179 * 86_400_000).toISOString();
    const json = await call(db, 'POST', '/auth', {
      access: { valid_until: validUntil },
      aspsp: { name: bankId, country: 'NO' },
      state,
      redirect_url: redirectUrl,
      psu_type: 'personal',
    });
    return { url: json.url, pending: { bank: bankId } };
  },

  async complete(db, { code, pending }) {
    const session = await call(db, 'POST', '/sessions', { code });
    const accounts = (session.accounts ?? []).map((a: any) => {
      const name = a.name || a.product || a.details || a.account_id?.iban || 'Account';
      return {
        remoteId: a.uid,
        name,
        iban: a.account_id?.iban ?? a.account_id?.other?.identification,
        currency: a.currency,
        kind: a.cash_account_type === 'CARD' ? 'credit' : kindFromName(`${name} ${a.product ?? ''}`),
      };
    });
    return {
      name: pending.bank ?? session.aspsp?.name ?? 'Bank',
      data: { session_id: session.session_id, bank: pending.bank },
      expiresAt: session.access?.valid_until,
      accounts,
    };
  },

  async fetch(db, _data, remoteId, since) {
    const transactions: RemoteTxn[] = [];
    let continuation: string | undefined;
    let guard = 0;
    do {
      const qs = new URLSearchParams({ date_from: since, date_to: todayISO() });
      if (continuation) qs.set('continuation_key', continuation);
      const page = await call(db, 'GET', `/accounts/${encodeURIComponent(remoteId)}/transactions?${qs}`);
      for (const t of page.transactions ?? []) {
        // Only booked transactions: pending ones often change amount or disappear.
        if (t.status && t.status !== 'BOOK') continue;
        const sign = t.credit_debit_indicator === 'DBIT' ? -1 : 1;
        const amount = sign * Math.abs(toOre(t.transaction_amount?.amount ?? 0));
        const counterparty = sign < 0 ? t.creditor?.name : t.debtor?.name;
        const remittance = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : t.remittance_information ?? '';
        const date = t.booking_date ?? t.value_date ?? t.transaction_date;
        if (!date) continue;
        transactions.push({
          externalId:
            t.entry_reference ?? t.transaction_id ?? crypto.createHash('sha1').update(JSON.stringify([date, amount, remittance])).digest('hex'),
          date: date.slice(0, 10),
          amount,
          description: [remittance, counterparty].filter(Boolean).join(' ').trim() || counterparty || 'Unknown',
          payee: counterparty || undefined,
        });
      }
      continuation = page.continuation_key || undefined;
    } while (continuation && ++guard < 50);

    let balance: number | undefined;
    try {
      const b = await call(db, 'GET', `/accounts/${encodeURIComponent(remoteId)}/balances`);
      const pick =
        b.balances?.find((x: any) => ['CLBD', 'ITBD', 'XPCD'].includes(x.balance_type)) ?? b.balances?.[0];
      if (pick) balance = toOre(pick.balance_amount?.amount ?? 0);
    } catch {
      // Balances are a nice-to-have.
    }
    return { transactions, balance };
  },
};

