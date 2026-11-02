import { describe, expect, it } from 'vitest';
import { parseAmount, parseDate, previewCsv } from './import/csv.ts';

describe('parseAmount', () => {
  it.each([
    ['1 234,56', 123456],
    ['-1234,56', -123456],
    ['1.234,56', 123456],
    ['-12.50', -1250],
    ['kr 99,-', 9900],
    ['1 000', 100000],
    ['(45,00)', -4500],
    ['', null],
    ['abc', null],
  ])('%s → %s', (input, expected) => expect(parseAmount(input)).toBe(expected));
});

describe('parseDate', () => {
  it('reads Norwegian and ISO dates', () => {
    expect(parseDate('03.10.2026', 'dmy')).toBe('2026-10-03');
    expect(parseDate('3.10.26', 'dmy')).toBe('2026-10-03');
    expect(parseDate('2026-10-03 14:22:01', 'ymd')).toBe('2026-10-03');
  });
});

describe('previewCsv', () => {
  it('detects SpareBank 1 exports with in/out columns', () => {
    const text = 'Dato;Beskrivelse;Rentedato;Inn;Ut;Til konto;Fra konto\n01.10.2026;VISA VARE *1234 REMA 1000 GRIMSTAD;01.10.2026;;-349,90;;\n25.09.2026;LØNN;25.09.2026;45 000,00;;;\n';
    const p = previewCsv(text, 'checking');
    expect(p.format).toBe('SpareBank 1');
    expect(p.rows).toEqual([
      { date: '2026-10-01', amount: -34990, description: 'VISA VARE *1234 REMA 1000 GRIMSTAD' },
      { date: '2026-09-25', amount: 4500000, description: 'LØNN' },
    ]);
  });

  it('detects DNB exports', () => {
    const text = '"Dato";"Forklaring";"Rentedato";"Ut fra konto";"Inn på konto"\n"02.10.2026";"Kiwi 123 Oslo";"02.10.2026";"215,40";""\n';
    const p = previewCsv(text, 'credit');
    expect(p.format).toBe('DNB');
    expect(p.rows[0].amount).toBe(-21540);
  });

  it('reads Revolut exports, skipping reverted rows and including fees', () => {
    const text = [
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
      'CARD_PAYMENT,Current,2026-10-01 12:00:00,2026-10-02 09:00:00,Rema 1000,-120.50,0.00,NOK,COMPLETED,500',
      'CARD_PAYMENT,Current,2026-10-01 13:00:00,,Wolt,-300.00,0.00,NOK,REVERTED,500',
      'EXCHANGE,Current,2026-10-03 10:00:00,2026-10-03 10:00:00,Exchanged to EUR,-1000.00,5.00,NOK,COMPLETED,0',
    ].join('\n');
    const p = previewCsv(text, 'checking');
    expect(p.format).toBe('Revolut');
    expect(p.rows.map((r) => r.amount)).toEqual([-12050, -100500]);
    expect(p.skipped).toBe(1);
  });

  it('flips signs on credit card exports that list purchases as positive', () => {
    const text = 'Dato;Tekst;Beløp\n01.10.2026;Kiwi;100,00\n02.10.2026;Rema;200,00\n03.10.2026;Meny;50,00\n04.10.2026;Innbetaling;-350,00\n';
    const p = previewCsv(text, 'credit');
    expect(p.mapping.invert).toBe(true);
    expect(p.rows.map((r) => r.amount)).toEqual([-10000, -20000, -5000, 35000]);
  });
});

describe('balance from the file', () => {
  it('reads the Saldo on the newest row, and works out that a credit card balance is debt', () => {
    // Newest first, purchases positive (inverted), balance positive and growing with each purchase.
    const text = ['Dato;Beskrivelse;Beløp;Saldo', '05.11.2026;Rema;200,00;5 302,00', '03.11.2026;Kiwi;100,00;5 102,00', '01.11.2026;Elkjøp;300,00;5 002,00', '31.10.2026;XXL;50,00;4 702,00'].join('\n');
    const p = previewCsv(text, 'credit');
    expect(p.mapping.invert).toBe(true);
    expect(p.balance).toEqual({ amount: -530200, date: '2026-11-05' });
  });

  it('keeps the sign when the balance moves with the amounts (a bank account, oldest first)', () => {
    const text = ['Dato;Beskrivelse;Inn;Ut;Saldo', '01.11.2026;Lønn;30 000,00;;31 000,00', '02.11.2026;Rema;;500,00;30 500,00'].join('\n');
    expect(previewCsv(text, 'checking').balance).toEqual({ amount: 3050000, date: '2026-11-02' });
  });

  it('has no balance when the file has none', () => {
    expect(previewCsv('Dato;Beskrivelse;Beløp\n01.11.2026;Rema;-500,00', 'checking').balance).toBeNull();
  });
});

describe('balance carried from the last bill', () => {
  it('adds every row to "Skyldig beløp fra forrige faktura" (DNB card export)', () => {
    const text = [
      'Dato;Beløpet gjelder;Valuta;Kurs;Inn;Ut',
      ';Skyldig beløp fra forrige faktura;;;;11670,68',
      '01.11.2026;Klarna*begood.no, Stockholm;;;;597,00',
      '20.10.2026;Innbetaling;;;10600,00;',
      '20.10.2026;DRESSMANN 197, Skien;;;;1616,30',
    ].join('\n');
    const p = previewCsv(text, 'credit');
    expect(p.rows).toHaveLength(3);
    expect(p.skipped).toBe(0);
    expect(p.balance).toEqual({ amount: -(1167068 + 59700 - 1060000 + 161630), date: '2026-11-01', computed: true });
  });
});
