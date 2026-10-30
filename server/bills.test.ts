import { describe, expect, it } from 'vitest';
import { get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { addBill, deleteBill, listBills, updateBill } from './bills.ts';

function setup() {
  const db = openDb(':memory:');
  const cat = (n: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', n)!.id;
  const acc = Number(run(db, "INSERT INTO accounts(name) VALUES ('SB1')").lastInsertRowid);
  return { db, cat, acc };
}
const target = (db: any, id: number) => get<any>(db, 'SELECT target_type, target_amount FROM categories WHERE id = ?', id);

describe('faste regninger', () => {
  it('sets the category goal to the sum of its bills, a yearly one as a twelfth', () => {
    const { db, cat } = setup();
    const ins = cat('Forsikring');
    addBill(db, { name: 'Gjensidige hus', amount: 89_900, due_day: 12, category_id: ins });
    const car = addBill(db, { name: 'If bil', amount: 600_000, every: 12, next_due: '2027-03-01', category_id: ins });
    expect(target(db, ins)).toEqual({ target_type: 'monthly', target_amount: 89_900 + 50_000 });
    updateBill(db, car, { name: 'If bil', amount: 600_000, every: 12, next_due: '2027-03-01', category_id: cat('Strøm') });
    expect(target(db, ins).target_amount).toBe(89_900);
    deleteBill(db, car);
    expect(target(db, cat('Strøm'))).toEqual({ target_type: null, target_amount: null });
  });

  it('sees when this month’s payment has come through', () => {
    const { db, cat, acc } = setup();
    addBill(db, { name: 'Tibber', amount: 200_000, due_day: 5, category_id: cat('Strøm') });
    addBill(db, { name: 'Lånekassen', amount: 120_000, due_day: 20 });
    run(db, "INSERT INTO transactions(account_id, date, amount, payee, raw_description) VALUES (?, '2026-10-06', -233258, 'Tibber', 'Nettgiro til: TIBBER NORGE AS')", acc);
    const { bills } = listBills(db, '2026-10-10');
    expect(bills.map((b) => [b.name, b.due, b.paid?.amount ?? null])).toEqual([
      ['Tibber', '2026-10-05', 233_258],
      ['Lånekassen', '2026-10-20', null],
    ]);
  });

  it('rolls a yearly due date forward', () => {
    const { db } = setup();
    addBill(db, { name: 'Bilavgift', amount: 300_000, every: 12, next_due: '2025-03-20' });
    expect(listBills(db, '2026-10-10').bills[0].due).toBe('2027-03-20');
  });

  it('rejects a bill without an amount', () => {
    const { db } = setup();
    expect(() => addBill(db, { name: 'X', amount: 0 })).toThrow();
  });
});
