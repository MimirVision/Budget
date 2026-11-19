import { describe, expect, it } from 'vitest';
import { all, get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { ingest, linkTransfer, rejectTransferSuggestion, transferToAccount } from './ingest.ts';
import { findDuplicates } from './duplicates.ts';
import { addDays, todayISO } from '../shared/months.ts';

const d = (n: number) => addDays(todayISO(), -n);

function setup() {
  const db = openDb(':memory:');
  const acc = (name: string) => Number(run(db, "INSERT INTO accounts(name, kind, on_budget) VALUES (?, 'checking', 1)", name).lastInsertRowid);
  const andreas = acc('Andreas');
  const nikita = acc('Nikita');
  const regninger = acc('Regninger');
  let n = 0;
  const add = (account: number, daysAgo: number, amount: number, text: string) =>
    ingest(db, account, [{ date: d(daysAgo), amount, description: text, externalId: `x${++n}` }], 'sparebank1').ids[0];
  const t = (id: number) => get<any>(db, 'SELECT * FROM transactions WHERE id = ?', id);
  return { db, andreas, nikita, regninger, add, t };
}

describe('Overføringer som gikk i ring', () => {
  it('two 5 000 kr transfers from Nikita are two transfers, not duplicates, and stay done', () => {
    const { db, andreas, nikita, add, t } = setup();
    const a = add(andreas, 2, 500000, 'Nikita Marlen H. Liaunet');
    const b = add(andreas, 1, 500000, 'Nikita Marlen H. Liaunet');
    // Nikita's account has nothing from the bank: you mark both as transfers, and the app makes her halves.
    transferToAccount(db, a, nikita);
    transferToAccount(db, b, nikita);
    expect([t(a).reviewed, t(b).reviewed]).toEqual([1, 1]);
    expect(findDuplicates(db).groups).toEqual([]);
  });

  it('remembers "Nei, ikke en overføring" when another of the same amount comes in', () => {
    const { db, andreas, regninger, add, t } = setup();
    const out = add(andreas, 3, -500000, 'Til Regninger');
    const inn = add(regninger, 3, 500000, 'Fra Andreas');
    expect(t(inn).suggested_transfer_id).toBe(out);
    rejectTransferSuggestion(db, inn);
    expect([t(out).suggested_transfer_id, t(inn).suggested_transfer_id]).toEqual([null, null]);
    // A new 5 000 kr into Regninger a day later: the rejected one is not offered as its other half.
    const later = add(regninger, 2, 500000, 'Fra Andreas');
    expect(t(later).suggested_transfer_id).toBeNull();
    expect(t(out).suggested_transfer_id).toBeNull();
  });

  it('does not cross two equal transfers, and moving a link leaves nothing pointing at the old half', () => {
    const { db, andreas, nikita, regninger, add, t } = setup();
    const fromA = add(andreas, 2, -500000, 'Til Regninger');
    const fromN = add(nikita, 2, -500000, 'Til Regninger');
    const in1 = add(regninger, 2, 500000, 'Overføring');
    const in2 = add(regninger, 2, 500000, 'Overføring');
    // Each incoming 5 000 is guessed with its own half, both ways, never two pointing at the same one.
    const guesses = [t(in1).suggested_transfer_id, t(in2).suggested_transfer_id].filter(Boolean);
    expect(new Set(guesses).size).toBe(guesses.length);
    for (const id of [in1, in2]) {
      const other = t(id).suggested_transfer_id;
      if (other) expect(t(other).suggested_transfer_id).toBe(id);
    }
    // Linked one way, then moved: the first partner is free again and nothing points at a taken half.
    linkTransfer(db, in1, fromA);
    linkTransfer(db, in1, fromN);
    expect(t(fromA)).toMatchObject({ transfer_id: null, reviewed: 0 });
    expect([t(in1).transfer_id, t(fromN).transfer_id]).toEqual([fromN, in1]);
    expect(all(db, 'SELECT id FROM transactions WHERE suggested_transfer_id IN (?, ?)', in1, fromN)).toEqual([]);
  });
});
