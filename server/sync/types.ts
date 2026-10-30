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
  ): Promise<{ transactions: RemoteTxn[]; balance?: number; data?: Record<string, any> }>;
}

export class ReauthRequired extends Error {}

export function toOre(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}
