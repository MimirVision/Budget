import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { safeEqual, signRS256, stableId } from './webcrypto.ts';

describe('webcrypto', () => {
  it('signs RS256 like node:crypto, for PKCS#8 and PKCS#1 keys', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const type of ['pkcs8', 'pkcs1'] as const) {
      const pem = privateKey.export({ type, format: 'pem' }).toString();
      const sig = await signRS256(pem, 'header.payload');
      const ok = crypto.verify('RSA-SHA256', Buffer.from('header.payload'), publicKey, Buffer.from(sig, 'base64url'));
      expect(ok).toBe(true);
    }
  });

  it('makes stable ids and compares safely', () => {
    expect(stableId('a')).toBe(stableId('a'));
    expect(stableId('a')).not.toBe(stableId('b'));
    expect(stableId('a')).toHaveLength(28);
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'secreT')).toBe(false);
    expect(safeEqual('secret', 'secret1')).toBe(false);
  });
});
