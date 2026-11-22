import { describe, expect, it } from 'vitest';
import { all, run } from './db.ts';
import { openDb } from './db-node.ts';
import { ingest } from './ingest.ts';

describe('Samme betaling med ny id fra banken', () => {
  it('does not add a copy each sync when the payment sits at the start of the sync window', () => {
    const db = openDb(':memory:');
    const acc = Number(run(db, "INSERT INTO accounts(name, kind, on_budget) VALUES ('Andreas', 'checking', 1)").lastInsertRowid);
    const pay = (id: string) => ({ externalId: id, date: '2026-11-14', amount: -3546300, description: 'DNB MC' });
    const coffee = { externalId: 'k1', date: '2026-11-21', amount: -4500, description: 'Kaffe' };
    // First sync, then four more where the 14th is right at the edge (since = 21st − 7 days) and the bank
    // hands the same payment a new id every time.
    ingest(db, acc, [pay('a'), coffee], 'sparebank1', { since: '2026-11-07' });
    for (const id of ['b', 'c', 'd', 'e']) ingest(db, acc, [pay(id), coffee], 'sparebank1', { since: '2026-11-14' });
    expect(all(db, 'SELECT external_id FROM transactions WHERE amount = -3546300')).toEqual([{ external_id: 'e' }]);
    // The bank going back to an old id doesn't make a copy either.
    ingest(db, acc, [pay('b'), coffee], 'sparebank1', { since: '2026-11-14' });
    expect(all(db, 'SELECT id FROM transactions WHERE amount = -3546300').length).toBe(1);
  });

  it('still adds two real, equal payments on the same day', () => {
    const db = openDb(':memory:');
    const acc = Number(run(db, "INSERT INTO accounts(name, kind, on_budget) VALUES ('Andreas', 'checking', 1)").lastInsertRowid);
    const two = [
      { externalId: 'x1', date: '2026-11-14', amount: -500000, description: 'Til sparing' },
      { externalId: 'x2', date: '2026-11-14', amount: -500000, description: 'Til sparing' },
    ];
    ingest(db, acc, two, 'sparebank1', { since: '2026-11-07' });
    ingest(db, acc, two, 'sparebank1', { since: '2026-11-14' });
    expect(all(db, 'SELECT external_id FROM transactions ORDER BY external_id')).toEqual([{ external_id: 'x1' }, { external_id: 'x2' }]);
  });
});
