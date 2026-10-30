import type { DB } from '../db.ts';

export interface RemoteAccount {
  remoteId: string;
  name: string;
  iban?: string;
  currency?: string;
  kind?: 'checking' | 'savings' | 'credit';
  balance?: number; // øre
}

export interface RemoteTxn {
  externalId: string;
  date: string;
  amount: number; // øre
  description: string;
  payee?: string;
}

export interface Bank {
  id: string;
  name: string;
  logo?: string;
}

export interface StartResult {
  url: string;
  pending?: Record<string, unknown>; // remembered until the bank redirects back
}

export interface CompleteResult {
  name: string;
  data: Record<string, unknown>;
  expiresAt?: string;
  accounts: RemoteAccount[];
}

export interface Provider {
  id: string;
  label: string;
  description: string;
  /** Where the bank sends you back after BankID, relative to the app address. Defaults to /api/connections/callback/<id>. */
  redirectPath?: string;
  /** Which settings keys are needed, with friendly labels for the setup form. */
  settings: Array<{ key: string; label: string; secret?: boolean; multiline?: boolean; help?: string }>;
  isConfigured(db: DB): boolean;
  listBanks?(db: DB, country?: string): Promise<Bank[]>;
  start(db: DB, opts: { bankId?: string; redirectUrl: string; state: string }): Promise<StartResult>;
  complete(
    db: DB,
    opts: { code: string; state: string; redirectUrl: string; pending: Record<string, any> },
  ): Promise<CompleteResult>;
  fetch(
    db: DB,
    data: Record<string, any>,
    remoteId: string,
    since: string,
    psu?: PsuContext,
  ): Promise<{ transactions: RemoteTxn[]; pending?: RemoteTxn[]; balance?: number; data?: Record<string, any> }>;
}

/**
 * Set when you are using the app right now (tapping "Synkroniser nå" or connecting a bank). PSD2 limits
 * background fetches to 4 per account per day; fetches made while you're present don't count, but only
 * if the bank is told so.
 */
export interface PsuContext {
  ip: string;
  userAgent: string;
}

export class ReauthRequired extends Error {}

export function toOre(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}
