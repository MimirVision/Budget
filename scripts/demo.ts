/**
 * Fills a database with six months of realistic household data so you can try the app without connecting a bank.
 *   DATA_DIR=./demo-data npx tsx scripts/demo.ts && DATA_DIR=./demo-data npm run dev
 */
import path from 'node:path';
import fs from 'node:fs';
import { all, get, run } from '../server/db.ts';
import { openDb } from '../server/db-node.ts';
import { ingest, linkTransfer, withImportHashes } from '../server/ingest.ts';
import { autoAssign, setAssigned } from '../server/budget.ts';
import { addDays, addMonths, currentMonth, todayISO } from '../shared/months.ts';

const dir = process.env.DATA_DIR ?? './demo-data';
fs.rmSync(path.join(dir, 'budget.db'), { force: true });
fs.rmSync(path.join(dir, 'budget.db-wal'), { force: true });
fs.rmSync(path.join(dir, 'budget.db-shm'), { force: true });
const db = openDb(path.join(dir, 'budget.db'));

const account = (name: string, kind: string, institution: string, onBudget = 1) =>
  Number(run(db, 'INSERT INTO accounts(name, kind, institution, on_budget) VALUES (?, ?, ?, ?)', name, kind, institution, onBudget).lastInsertRowid);
const cat = (name: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', name)!.id;

const sb1 = account('Brukskonto', 'checking', 'SpareBank 1 Sør-Norge');
const revolut = account('Revolut', 'checking', 'Revolut');
const dnb = account('DNB Mastercard', 'credit', 'DNB');
const tf = account('TF Bank Mastercard', 'credit', 'TF Bank');
const mortgage = account('Boliglån', 'loan', 'SpareBank 1 Sør-Norge', 0);

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const between = (a: number, b: number) => Math.round((a + rand() * (b - a)) * 100);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

type Row = { date: string; amount: number; description: string };
const rows: Record<number, Row[]> = { [sb1]: [], [revolut]: [], [dnb]: [], [tf]: [] };
const today = todayISO();
const start = addMonths(currentMonth(), -6);

for (let m = 0; m <= 6; m++) {
  const month = addMonths(start, m);
  const d = (day: number) => `${month}-${String(day).padStart(2, '0')}`;
  const add = (acc: number, day: number, amount: number, description: string) => {
    if (d(day) <= today) rows[acc].push({ date: d(day), amount, description });
  };
  add(sb1, 20, 4_350_000, 'LØNN FRA ARBEIDSGIVER AS');
  add(sb1, 25, 3_120_000, 'Lønn Agder Kommune');
  add(sb1, 1, -1_480_000, 'AvtaleGiro SpareBank 1 Boliglån');
  add(sb1, 5, -between(900, 2400), 'Nettgiro til: TIBBER NORGE AS Betalt: 05');
  add(sb1, 12, -89_900, 'eFaktura Gjensidige Forsikring');
  add(sb1, 15, -69_900, 'AvtaleGiro TELENOR NORGE AS');
  add(sb1, 10, -310_000, 'AvtaleGiro Barnehage Grimstad kommune');
  if (m % 3 === 0) add(sb1, 28, -420_000, 'Grimstad kommune kommunale avgifter');
  add(sb1, 3, -800_000, 'Overføring til Revolut');
  add(revolut, 3, 800_000, 'Top-Up by *4421');
  for (let i = 0; i < 9; i++) add(revolut, 1 + Math.floor(rand() * 27), -between(180, 1200), pick(['Rema 1000', 'Kiwi', 'Coop Extra', 'Meny', 'Rema 1000']));
  for (let i = 0; i < 3; i++) add(revolut, 1 + Math.floor(rand() * 27), -between(150, 600), pick(['Wolt', 'Peppes Pizza', 'Espresso House', 'Foodora']));
  add(revolut, 8, -12_900, 'Netflix.com');
  add(revolut, 9, -11_900, 'Spotify');
  for (let i = 0; i < 4; i++) add(dnb, 1 + Math.floor(rand() * 27), -between(300, 1400), pick(['VISA VARE *8812 REMA 1000 GRIMSTAD', 'VISA VARE *8812 CIRCLE K GRIMSTAD', 'VISA VARE *8812 APOTEK 1 AMFI', 'VISA VARE *8812 CLAS OHLSON']));
  add(dnb, 14, -between(400, 900), 'VISA VARE *8812 UNO-X 7-ELEVEN');
  if (m === 2) add(dnb, 18, -489_000, 'VISA VARE *8812 ELKJØP ARENDAL');
  for (let i = 0; i < 2; i++) add(tf, 1 + Math.floor(rand() * 27), -between(250, 900), pick(['KIWI 505 GRIMSTAD', 'H&M ARENDAL', 'XXL SØRLANDSSENTERET']));
}

// The credit cards get paid from SpareBank 1 a little after the month ends.
for (const [card, label] of [
  [dnb, 'Nettgiro til: DNB KORTSENTER'],
  [tf, 'Nettgiro til: TF BANK AB'],
] as const) {
  const byMonth = new Map<string, number>();
  for (const r of rows[card]) byMonth.set(r.date.slice(0, 7), (byMonth.get(r.date.slice(0, 7)) ?? 0) + r.amount);
  for (const [month, total] of byMonth) {
    const date = `${addMonths(month, 1)}-12`;
    if (date > today) continue;
    rows[sb1].push({ date, amount: total, description: label });
    rows[card].push({ date: addDays(date, 1), amount: -total, description: 'Innbetaling, takk' });
  }
}

const source: Record<number, string> = { [sb1]: 'sparebank1', [revolut]: 'enablebanking', [dnb]: 'enablebanking', [tf]: 'csv' };
for (const [acc, list] of Object.entries(rows)) ingest(db, Number(acc), withImportHashes(list.sort((a, b) => a.date.localeCompare(b.date))), source[Number(acc)]);

// Opening balances and a mortgage to track.
run(db, `INSERT INTO transactions(account_id, date, amount, payee, category_id, reviewed) VALUES (?, ?, 4500000, 'Startsaldo', ?, 1)`, sb1, `${start}-01`, cat('Annen inntekt'));
run(db, `INSERT INTO transactions(account_id, date, amount, payee, reviewed) VALUES (?, ?, -285000000, 'Startsaldo', 1)`, mortgage, `${start}-01`);
for (let m = 0; m <= 6; m++) {
  const date = `${addMonths(start, m)}-01`;
  if (date <= today) run(db, `INSERT INTO transactions(account_id, date, amount, payee, reviewed) VALUES (?, ?, 1020000, 'Avdrag', 1)`, mortgage, date);
}

// Pretend the household has been using the app: approve everything older than ~10 days.
const cutoff = addDays(today, -10);
for (const t of all<any>(db, 'SELECT * FROM transactions WHERE reviewed = 0 AND date < ?', cutoff)) {
  const fresh = get<any>(db, 'SELECT * FROM transactions WHERE id = ?', t.id);
  if (fresh.reviewed) continue;
  if (fresh.suggested_transfer_id) linkTransfer(db, t.id, fresh.suggested_transfer_id);
  else run(db, 'UPDATE transactions SET category_id = suggested_category_id, reviewed = 1 WHERE id = ?', t.id);
}
// Things the merchant list doesn't know.
run(db, "UPDATE transactions SET category_id = ? WHERE payee LIKE '%Boliglån%' AND category_id IS NULL", cat('Boliglån'));
run(db, "UPDATE transactions SET category_id = ? WHERE payee LIKE 'Grimstad Kommune%' AND category_id IS NULL", cat('Kommunale avgifter'));
run(db, "UPDATE transactions SET category_id = ? WHERE payee LIKE 'Elkjøp%'", cat('Hus og apotek'));

// Targets and past budgets.
run(db, "UPDATE categories SET target_type = 'monthly', target_amount = 1480000 WHERE name = 'Boliglån'");
run(db, "UPDATE categories SET target_type = 'monthly', target_amount = 600000 WHERE name = 'Dagligvarer'");
run(db, "UPDATE categories SET target_type = 'monthly', target_amount = 200000 WHERE name = 'Strøm'");
run(db, "UPDATE categories SET target_type = 'by_date', target_amount = 3000000, target_date = ? WHERE name = 'Ferie'", addMonths(currentMonth(), 8));
run(db, "UPDATE categories SET target_type = 'balance', target_amount = 5000000 WHERE name = 'Buffer'");
for (let m = 0; m <= 6; m++) {
  const month = addMonths(start, m);
  autoAssign(db, month, 'last_month_spent');
  autoAssign(db, month, 'targets');
  if (m === 6) break; // this month's leftovers are yours to assign
  setAssigned(db, month, cat('Buffer'), 3_000_000);
  setAssigned(db, month, cat('Jul og gaver'), 150_000);
}

console.log(`Demo data written to ${path.join(dir, 'budget.db')}`);
