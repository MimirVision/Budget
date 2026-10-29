import { beforeEach, describe, expect, it } from 'vitest';
import { all, get, openDb, run, type DB } from './db.ts';
import { autoAssign, getBudget, readyToAssign, setAssigned } from './budget.ts';
import { ingest, linkTransfer, transferToAccount, withImportHashes } from './ingest.ts';

let db: DB;
const cat = (name: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', name)!.id;
const account = (name: string, kind = 'checking') =>
  Number(run(db, 'INSERT INTO accounts(name, kind) VALUES (?, ?)', name, kind).lastInsertRowid);
const addTx = (accountId: number, date: string, amount: number, category: string | null, payee = 'x') =>
  Number(
    run(
      db,
      'INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed) VALUES (?, ?, ?, ?, ?, 1)',
      accountId,
      date,
      amount,
      payee,
      category ? cat(category) : null,
    ).lastInsertRowid,
  );
const row = (month: string, name: string) =>
  getBudget(db, month).groups.flatMap((g) => g.categories).find((c) => c.name === name)!;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('budget', () => {
  it('income goes to Ready to assign and assigning takes it out', () => {
    const sb1 = account('SpareBank 1');
    addTx(sb1, '2026-09-25', 4_000_000, 'Lønn');
    expect(readyToAssign(db)).toBe(4_000_000);
    setAssigned(db, '2026-10', cat('Dagligvarer'), 800_000);
    expect(readyToAssign(db)).toBe(3_200_000);
  });

  it('rolls leftovers and overspending into the next month', () => {
    const sb1 = account('SpareBank 1');
    setAssigned(db, '2026-09', cat('Dagligvarer'), 500_000);
    addTx(sb1, '2026-09-10', -300_000, 'Dagligvarer');
    expect(row('2026-09', 'Dagligvarer').available).toBe(200_000);
    expect(row('2026-10', 'Dagligvarer').available).toBe(200_000);
    addTx(sb1, '2026-10-05', -350_000, 'Dagligvarer');
    expect(row('2026-10', 'Dagligvarer').available).toBe(-150_000);
  });

  it('credit card spending is spending, and paying the card is just a transfer', () => {
    const sb1 = account('SpareBank 1');
    const dnb = account('DNB Mastercard', 'credit');
    addTx(sb1, '2026-10-01', 1_000_000, 'Lønn');
    setAssigned(db, '2026-10', cat('Dagligvarer'), 400_000);
    addTx(dnb, '2026-10-03', -250_000, 'Dagligvarer');
    const out = addTx(sb1, '2026-10-20', -250_000, null);
    const into = addTx(dnb, '2026-10-21', 250_000, null);
    linkTransfer(db, out, into);
    const b = getBudget(db, '2026-10');
    expect(row('2026-10', 'Dagligvarer').available).toBe(150_000);
    expect(b.readyToAssign).toBe(600_000);
    expect(b.uncategorized.count).toBe(0);
    // Money in accounts = money in categories + ready to assign.
    const cash = get<{ s: number }>(db, 'SELECT SUM(amount) AS s FROM transactions')!.s;
    expect(cash).toBe(b.readyToAssign + b.available);
  });

  it('targets tell you how much is needed', () => {
    run(db, "UPDATE categories SET target_type = 'by_date', target_amount = 1200000, target_date = '2027-03' WHERE id = ?", cat('Ferie'));
    expect(row('2026-10', 'Ferie').needed).toBe(200_000); // 12 000 over 6 months
    run(db, "UPDATE categories SET target_type = 'monthly', target_amount = 150000 WHERE id = ?", cat('Strøm'));
    setAssigned(db, '2026-10', cat('Strøm'), 50_000);
    expect(row('2026-10', 'Strøm').needed).toBe(100_000);
  });

  it('auto-assign funds targets without going below zero', () => {
    const sb1 = account('SpareBank 1');
    addTx(sb1, '2026-10-01', 250_000, 'Lønn');
    run(db, "UPDATE categories SET target_type = 'monthly', target_amount = 200000 WHERE id IN (?, ?)", cat('Boliglån'), cat('Strøm'));
    autoAssign(db, '2026-10', 'targets');
    expect(row('2026-10', 'Boliglån').assigned).toBe(200_000);
    expect(row('2026-10', 'Strøm').assigned).toBe(50_000);
    expect(readyToAssign(db)).toBe(0);
  });

  it('split transactions count in each category', () => {
    const sb1 = account('SpareBank 1');
    const id = addTx(sb1, '2026-10-02', -100_000, null);
    run(db, 'INSERT INTO splits(transaction_id, category_id, amount) VALUES (?, ?, ?), (?, ?, ?)', id, cat('Dagligvarer'), -70_000, id, cat('Hus og apotek'), -30_000);
    expect(row('2026-10', 'Dagligvarer').activity).toBe(-70_000);
    expect(row('2026-10', 'Hus og apotek').activity).toBe(-30_000);
  });
});

describe('ingest', () => {
  it('cleans payees, suggests categories, and skips duplicates on re-import', () => {
    const sb1 = account('SpareBank 1');
    const rows = withImportHashes([
      { date: '2026-10-01', amount: -34_990, description: 'VISA VARE *1234 REMA 1000 GRIMSTAD' },
      { date: '2026-10-01', amount: -4_500, description: 'VISA VARE *1234 KAFFEBAR' },
      { date: '2026-10-01', amount: -4_500, description: 'VISA VARE *1234 KAFFEBAR' },
    ]);
    const first = ingest(db, sb1, rows, 'csv');
    expect(first.added).toBe(3);
    const rema = get<any>(db, "SELECT * FROM transactions WHERE payee = 'Rema 1000'");
    expect(rema.suggested_category_id).toBe(cat('Dagligvarer'));
    expect(rema.reviewed).toBe(0);
    const again = ingest(db, sb1, rows, 'csv');
    expect(again).toMatchObject({ added: 0, duplicates: 3 });
  });

  it('learns from what you picked last time', () => {
    const sb1 = account('SpareBank 1');
    addTx(sb1, '2026-09-01', -20_000, 'Hobby og sport', 'Klatresenteret');
    ingest(db, sb1, [{ date: '2026-10-01', amount: -20_000, description: 'KLATRESENTERET', externalId: 'a' }], 'sparebank1');
    expect(get<any>(db, "SELECT * FROM transactions WHERE external_id = 'a'").suggested_category_id).toBe(cat('Hobby og sport'));
  });

  it('spots transfers between your own accounts', () => {
    const sb1 = account('SpareBank 1');
    const rev = account('Revolut');
    ingest(db, sb1, [{ date: '2026-10-01', amount: -200_000, description: 'Overføring til Revolut', externalId: '1' }], 'sparebank1');
    const r = ingest(db, rev, [{ date: '2026-10-02', amount: 200_000, description: 'Top-Up by *1234', externalId: '2' }], 'enablebanking');
    expect(r.transfers).toBe(1);
    const t = get<any>(db, "SELECT * FROM transactions WHERE external_id = '2'");
    expect(t.suggested_transfer_id).toBeTruthy();
  });

  it('matches a manually entered transaction when the bank catches up', () => {
    const rev = account('Revolut');
    addTx(rev, '2026-10-01', -15_000, 'Spise ute', 'Lunch');
    const r = ingest(db, rev, [{ date: '2026-10-02', amount: -15_000, description: 'Lunsjbaren', externalId: 'x' }], 'enablebanking');
    expect(r).toMatchObject({ added: 0, matched: 1 });
    expect(all(db, 'SELECT * FROM transactions WHERE account_id = ?', rev)).toHaveLength(1);
  });

  it('a transfer to an account that is not synced creates the other half', () => {
    const sb1 = account('SpareBank 1');
    const tf = account('TF Bank', 'credit');
    const id = addTx(sb1, '2026-10-20', -500_000, null);
    transferToAccount(db, id, tf);
    const other = get<any>(db, 'SELECT * FROM transactions WHERE account_id = ?', tf);
    expect(other.amount).toBe(500_000);
    expect(other.transfer_id).toBe(id);
    // When TF Bank's CSV shows up later, the payment is matched, not duplicated.
    const r = ingest(db, tf, withImportHashes([{ date: '2026-10-21', amount: 500_000, description: 'Innbetaling' }]), 'csv');
    expect(r.matched).toBe(1);
  });
});
