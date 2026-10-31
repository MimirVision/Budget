import { describe, expect, it } from 'vitest';
import { parseStatement, statementCsv } from './pdfStatement';

describe('PDF statement reader', () => {
  it('reads a typical credit card statement', () => {
    const lines = [
      'TF Bank Mastercard Kontoutskrift',
      'Periode 01.10.2026 - 31.10.2026',
      'Dato Beskrivelse Beløp',
      'Forrige saldo 1 176,23',
      '03.10 KIWI 512 GRIMSTAD 613,62',
      '05.10 06.10 REMA 1000 ARENDAL 1 234,50',
      '09.10 AMAZON.DE USD 12,00 128,40',
      '13.10 Innbetaling, takk 1 099,86-',
      'Sum kjøp 1 976,52',
      'Å betale 2 052,89',
    ];
    expect(parseStatement(lines, new Date('2026-11-02'))).toEqual([
      { date: '2026-10-03', description: 'KIWI 512 GRIMSTAD', amount: '613,62' },
      { date: '2026-10-05', description: 'REMA 1000 ARENDAL', amount: '1234,50' },
      { date: '2026-10-09', description: 'AMAZON.DE USD', amount: '128,40' },
      { date: '2026-10-13', description: 'Innbetaling, takk', amount: '-1099,86' },
    ]);
  });

  it('uses the amount column, not the balance, when there is a balance column', () => {
    const lines = ['Dato Tekst Beløp Saldo', '12.10.2026 Kiwi -562,61 -3 154,32'];
    expect(parseStatement(lines)).toEqual([{ date: '2026-10-12', description: 'Kiwi', amount: '-562,61' }]);
  });

  it('writes CSV the importer understands', () => {
    expect(statementCsv([{ date: '2026-10-03', description: 'KIWI "512"', amount: '613,62' }])).toBe(
      'Dato;Beskrivelse;Beløp\n03.10.2026;"KIWI ""512""";613,62',
    );
  });
});
