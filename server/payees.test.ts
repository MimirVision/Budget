import { describe, expect, it } from 'vitest';
import { cleanPayee, matchMerchant } from './payees.ts';

describe('cleanPayee', () => {
  it.each([
    ['VISA VARE 123456*1234 12.10 NOK 349,90 REMA 1000 GRIMSTAD Kurs: 1.0000', 'Rema 1000'],
    ['Varekjøp KIWI 505 LUNDSIDEN dato 01.10', 'Kiwi'],
    ['Nettgiro til: FJORDKRAFT AS Betalt: 03.10.26', 'Fjordkraft'],
    ['*4321 30.09 NOK 89,00 NETFLIX.COM Kurs: 1.0000', 'Netflix'],
    ['VISA VARE *9999 KAFFEBRENNERIET OSLO', 'Kaffebrenneriet Oslo'],
    ['Vipps*Ola Nordmann', 'Ola Nordmann'],
    ['iPhone repair shop', 'iPhone repair shop'],
    ['VISA VARE *1234 SPAR KVADRATUREN', 'Spar'],
    ['VISA VARE *1234 EXTRA STOKKE', 'Coop Extra'],
  ])('%s → %s', (raw, expected) => expect(cleanPayee(raw)).toBe(expected));

  it.each(['Overføring til spar', 'Ekstra innbetaling lån', 'spar', 'Innbetaling Spar konto'])(
    'does not mistake "%s" for a shop',
    (raw) => expect(matchMerchant(raw)).toBeUndefined(),
  );
});
