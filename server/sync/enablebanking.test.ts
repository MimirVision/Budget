import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { setSetting } from '../db.ts';
import { openDb } from '../db-node.ts';
import { enableBanking } from './enablebanking.ts';

describe('Enable Banking fetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tells the bank you are present only for syncs you start yourself', async () => {
    const db = openDb(':memory:');
    const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    setSetting(db, 'enablebanking_app_id', 'app');
    setSetting(db, 'enablebanking_private_key', pem);
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      calls.push(init.headers);
      return new Response(JSON.stringify({ transactions: [], balances: [] }), { status: 200 });
    });

    await enableBanking.fetch(db, {}, 'acc', '2026-11-01');
    expect(calls.every((h) => !('Psu-Ip-Address' in h))).toBe(true);

    calls.length = 0;
    await enableBanking.fetch(db, {}, 'acc', '2026-11-01', { ip: '203.0.113.7', userAgent: 'Mobil' });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((h) => h['Psu-Ip-Address'] === '203.0.113.7' && h['Psu-User-Agent'] === 'Mobil')).toBe(true);
  });
});
