/**
 * Forventet inntekt: the pay you expect each month (how much, and which day), so the budget can be divided up
 * before the money arrives. Nothing here changes Klar til fordeling, which only counts money that has come in;
 * the expected pay is shown beside it ("etter lønn"), and is marked as received when a matching payment shows up.
 */
import { all, get, run, tx, type DB } from './db.ts';
import { addDays, addMonths, currentMonth, daysInMonth, todayISO } from '../shared/months.ts';

export interface Income {
  id: number;
  name: string;
  amount: number;
  day: number;
  match: string;
  sort: number;
}

export interface IncomeStatus extends Income {
  /** When it's expected this month (the day, moved to the month's last day when the month is shorter). */
  expected: string;
  received: { id: number; date: string; amount: number } | null;
  status: 'received' | 'waiting' | 'late';
}

export interface IncomeInput {
  name: string;
  amount: number;
  day: number;
  match?: string;
}

const clampDay = (month: string, day: number) => `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`;

/** The expected pay for a month, and whether each has come in. */
export function incomesFor(db: DB, month: string, today = todayISO()): IncomeStatus[] {
  const incomes = all<Income>(db, 'SELECT * FROM incomes ORDER BY sort, id');
  const used = new Set<number>();
  return incomes.map((inc) => {
    const expected = clampDay(month, inc.day);
    // Pay can come a few days early (weekends, holidays) or a little late.
    const from = addDays(expected, -12);
    const to = addDays(expected, 7);
    const needle = inc.match.trim();
    const candidates = all<{ id: number; date: string; amount: number }>(
      db,
      `SELECT t.id, t.date, t.amount FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE a.on_budget = 1 AND t.amount > 0 AND t.transfer_id IS NULL AND t.date BETWEEN ? AND ?
          AND t.payee NOT IN ('Startsaldo', 'Saldojustering')
          ${needle ? 'AND (t.payee LIKE ? OR t.raw_description LIKE ?)' : 'AND t.amount BETWEEN ? AND ?'}
        ORDER BY abs(julianday(t.date) - julianday(?)), t.id`,
      from,
      to,
      ...(needle ? [`%${needle}%`, `%${needle}%`] : [Math.round(inc.amount * 0.5), Math.round(inc.amount * 1.5)]),
      expected,
    );
    const hit = candidates.find((c) => !used.has(c.id)) ?? null;
    if (hit) used.add(hit.id);
    const status: IncomeStatus['status'] = hit ? 'received' : today > addDays(expected, 3) ? 'late' : 'waiting';
    return { ...inc, expected, received: hit, status };
  });
}

/**
 * What's still to come, for the budget: the expected pay not yet received, from this month up to the month being
 * looked at (assigning ahead in December can count on both November's and December's pay). Past months: nothing.
 */
export function incomeOutlook(db: DB, month: string, today = todayISO()) {
  const now = currentMonth();
  const items = incomesFor(db, month, today);
  let pending = 0;
  let next: { name: string; date: string; amount: number } | null = null;
  if (month >= now) {
    for (let m = now; m <= month; m = addMonths(m, 1)) {
      for (const i of m === month ? items : incomesFor(db, m, today)) {
        if (i.received) continue;
        pending += i.amount;
        if (!next || i.expected < next.date) next = { name: i.name, date: i.expected, amount: i.amount };
      }
    }
  }
  return {
    items,
    expected: items.reduce((s, i) => s + i.amount, 0),
    received: items.reduce((s, i) => s + (i.received?.amount ?? 0), 0),
    pending,
    next,
  };
}

function clean(input: IncomeInput) {
  const name = String(input.name ?? '').trim().slice(0, 60);
  const amount = Math.round(Math.abs(Number(input.amount)));
  const day = Math.round(Number(input.day));
  if (!name) throw new Error('Gi inntekten et navn, for eksempel «Lønn Andreas»');
  if (!(amount > 0)) throw new Error('Skriv inn hvor mye du regner med å få');
  if (!(day >= 1 && day <= 31)) throw new Error('Velg hvilken dag i måneden pengene kommer');
  return { name, amount, day, match: String(input.match ?? '').trim().slice(0, 60) };
}

export function addIncome(db: DB, input: IncomeInput): number {
  const i = clean(input);
  return Number(
    run(
      db,
      'INSERT INTO incomes(name, amount, day, match, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM incomes))',
      i.name,
      i.amount,
      i.day,
      i.match,
    ).lastInsertRowid,
  );
}

export function updateIncome(db: DB, id: number, input: IncomeInput) {
  const i = clean(input);
  tx(db, () => {
    if (!get(db, 'SELECT 1 FROM incomes WHERE id = ?', id)) throw new Error('Fant ikke inntekten');
    run(db, 'UPDATE incomes SET name = ?, amount = ?, day = ?, match = ? WHERE id = ?', i.name, i.amount, i.day, i.match, id);
  });
}

export function deleteIncome(db: DB, id: number) {
  run(db, 'DELETE FROM incomes WHERE id = ?', id);
}
