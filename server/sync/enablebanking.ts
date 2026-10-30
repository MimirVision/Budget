/**
 * Enable Banking (https://enablebanking.com) — one PSD2 aggregator for DNB, SpareBank 1, Revolut and most
 * other European banks. Create an application in their control panel (restricted/personal mode lets you link
 * your own accounts for free), download the private key, and paste the application ID + key into Settings.
 */
import { getSetting, type DB } from '../db.ts';
import { todayISO } from '../../shared/months.ts';
import { base64url, signRS256, stableId } from '../webcrypto.ts';
import { ReauthRequired, toOre, type Provider, type PsuContext, type RemoteTxn } from './types.ts';

const API = 'https://api.enablebanking.com';

async function jwt(db: DB): Promise<string> {
  const appId = getSetting(db, 'enablebanking_app_id');
  const key = getSetting(db, 'enablebanking_private_key');
  if (!appId || !key) throw new Error('Enable Banking er ikke satt opp ennå. Legg inn applikasjons-ID og privat nøkkel under Innstillinger.');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: appId }));
  const payload = base64url(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 }));
  return `${header}.${payload}.${await signRS256(key, `${header}.${payload}`)}`;
}

async function call(db: DB, method: string, path: string, body?: unknown, psu?: PsuContext) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await jwt(db)}`,
      'Content-Type': 'application/json',
      // Tells the bank you're present, so this fetch doesn't use up the 4 background fetches a day.
      ...(psu ? { 'Psu-Ip-Address': psu.ip, 'Psu-User-Agent': psu.userAgent } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (res.status === 401 || res.status === 403 || json?.error === 'EXPIRED_SESSION') {
    throw new ReauthRequired(json?.message ?? 'Bankkoblingen har utløpt. Koble til på nytt med BankID.');
  }
  if (!res.ok) throw new Error(json?.message ?? json?.detail ?? `Feil fra Enable Banking (${res.status})`);
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
  // Same as SpareBank 1: the bank returns to the app's front page, which forwards to the API. One URL to register.
  redirectPath: '/',
  description: 'Kobler til DNB, SpareBank 1, Revolut og de fleste norske og europeiske banker med BankID.',
  settings: [
    { key: 'enablebanking_app_id', label: 'Applikasjons-ID', help: 'Fra kontrollpanelet hos Enable Banking → Applications.' },
    {
      key: 'enablebanking_private_key',
      label: 'Privat nøkkel (.pem)',
      secret: true,
      multiline: true,
      help: 'Nøkkelfilen du lastet ned da du opprettet applikasjonen.',
    },
  ],

  isConfigured: (db) => !!getSetting(db, 'enablebanking_app_id') && !!getSetting(db, 'enablebanking_private_key'),

  async listBanks(db, country = 'NO') {
    const cc = /^[A-Z]{2}$/.test(country) ? country : 'NO';
    const json = await call(db, 'GET', `/aspsps?country=${cc}&psu_type=personal`);
    // The id carries the country too: Revolut, for example, is listed under Lithuania (LT), not Norway.
    return (json.aspsps ?? []).map((a: any) => ({ id: `${a.name}|${a.country ?? cc}`, name: a.name, logo: a.logo }));
  },

  async start(db, { bankId, redirectUrl, state }) {
    if (!bankId) throw new Error('Velg en bank først');
    const [bankName, country = 'NO'] = bankId.split('|');
    // Banks allow at most 180 days before you have to confirm again with BankID; ask for the maximum.
    const validUntil = new Date(Date.now() + 179 * 86_400_000).toISOString();
    const json = await call(db, 'POST', '/auth', {
      access: { valid_until: validUntil },
      aspsp: { name: bankName, country },
      state,
      redirect_url: redirectUrl,
      psu_type: 'personal',
    });
    return { url: json.url, pending: { bank: bankId } };
  },

  async complete(db, { code, pending }) {
    const session = await call(db, 'POST', '/sessions', { code });
    const accounts = (session.accounts ?? []).map((a: any) => {
      const name = a.name || a.product || a.details || a.account_id?.iban || 'Konto';
      return {
        remoteId: a.uid,
        name,
        iban: a.account_id?.iban ?? a.account_id?.other?.identification,
        currency: a.currency,
        kind: a.cash_account_type === 'CARD' ? 'credit' : kindFromName(`${name} ${a.product ?? ''}`),
      };
    });
    return {
      name: String(pending.bank ?? session.aspsp?.name ?? 'Bank').split('|')[0],
      data: { session_id: session.session_id, bank: pending.bank },
      expiresAt: session.access?.valid_until,
      accounts,
    };
  },

  async fetch(db, _data, remoteId, since, psu) {
    const transactions: RemoteTxn[] = [];
    const pending: RemoteTxn[] = [];
    let continuation: string | undefined;
    let guard = 0;
    do {
      const qs = new URLSearchParams({ date_from: since, date_to: todayISO() });
      if (continuation) qs.set('continuation_key', continuation);
      const page = await call(db, 'GET', `/accounts/${encodeURIComponent(remoteId)}/transactions?${qs}`, undefined, psu);
      for (const t of page.transactions ?? []) {
        // Pending ones often change amount or disappear, so they're shown as "reservert" but not booked.
        const isPending = !!t.status && t.status !== 'BOOK';
        const sign = t.credit_debit_indicator === 'DBIT' ? -1 : 1;
        const amount = sign * Math.abs(toOre(t.transaction_amount?.amount ?? 0));
        const counterparty = sign < 0 ? t.creditor?.name : t.debtor?.name;
        const remittance = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : t.remittance_information ?? '';
        const date = t.booking_date ?? t.value_date ?? t.transaction_date;
        if (!date) continue;
        (isPending ? pending : transactions).push({
          externalId:
            t.entry_reference ?? t.transaction_id ?? stableId(JSON.stringify([date, amount, remittance])),
          date: date.slice(0, 10),
          amount,
          description: [remittance, counterparty].filter(Boolean).join(' ').trim() || counterparty || 'Ukjent',
          payee: counterparty || undefined,
        });
      }
      continuation = page.continuation_key || undefined;
    } while (continuation && ++guard < 50);

    let balance: number | undefined;
    try {
      const b = await call(db, 'GET', `/accounts/${encodeURIComponent(remoteId)}/balances`, undefined, psu);
      const pick =
        b.balances?.find((x: any) => ['CLBD', 'ITBD', 'XPCD'].includes(x.balance_type)) ?? b.balances?.[0];
      if (pick) balance = toOre(pick.balance_amount?.amount ?? 0);
    } catch {
      // Balances are a nice-to-have.
    }
    return { transactions, pending, balance };
  },
};

