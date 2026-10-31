import { describe, expect, it } from 'vitest';
import { get, run } from './db.ts';
import { openDb } from './db-node.ts';
import { payQuirks, priceChanges, seasonalPower } from './insights.ts';
import { expectRefund, listRefunds } from './refunds.ts';
import { ingest } from './ingest.ts';

function setup() {
  const db = openDb(':memory:');
  const acc = Number(run(db, "INSERT INTO accounts(name) VALUES ('SB1')").lastInsertRowid);
  const cat = (n: string) => get<{ id: number }>(db, 'SELECT id FROM categories WHERE name = ?', n)!.id;
  const tx = (date: string, amount: number, payee: string, c?: string) =>
    Number(run(db, 'INSERT INTO transactions(account_id, date, amount, payee, raw_description, category_id, reviewed) VALUES (?, ?, ?, ?, ?, ?, 1)', acc, date, amount, payee, payee, c ? cat(c) : null).lastInsertRowid);
  return { db, acc, cat, tx };
}

describe('smart tips', () => {
  it('spots a price increase on a steady subscription, not on a bill that always varies', () => {
    const { db, tx } = setup();
    for (const m of ['06', '07', '08', '09']) tx(`2026-${m}-08`, -12900, 'Netflix');
    tx('2026-10-08', -14900, 'Netflix');
    for (const [m, v] of [['07', -90000], ['08', -110000], ['09', -95000], ['10', -140000]] as const) tx(`2026-${m}-05`, v, 'Tibber');
    const tips = priceChanges(db, '2026-10-20');
    expect(tips).toHaveLength(1);
    expect(tips[0].text).toContain('Fra 129 kr til 149 kr');
    expect(tips[0].text).toContain('240 kr mer i året');
  });

  it('suggests an even monthly amount for power before winter', () => {
    const { db, tx } = setup();
    tx('2026-08-05', -60000, 'Tibber', 'Strøm');
    tx('2026-09-05', -70000, 'Tibber', 'Strøm');
    tx('2026-10-05', -100000, 'Tibber', 'Strøm');
    const [tip] = seasonalPower(db, '2026-10-20');
    expect(tip.kind).toBe('power');
    expect(tip.action).toMatchObject({ type: 'target' });
    // About 1 000 kr a month over the year from Aug–Oct at these levels.
    expect(tip.action!.amount).toBeGreaterThan(100000);
    expect(seasonalPower(db, '2026-04-10')).toEqual([]);
  });

  it('notices holiday pay in June and suggests putting it towards Ferie', () => {
    const { db, tx, cat } = setup();
    for (const m of ['03', '04', '05']) tx(`2026-${m}-20`, 4000000, 'Arbeidsgiver AS', 'Lønn');
    tx('2026-06-20', 6200000, 'Arbeidsgiver AS', 'Lønn');
    const [tip] = payQuirks(db, '2026-06-21');
    expect(tip.text).toContain('feriepenger');
    expect(tip.action).toMatchObject({ type: 'move', categoryId: cat('Ferie'), amount: 2200000 });
  });
});

describe('refunds', () => {
  it('matches the money coming back and suggests the purchase category', () => {
    const { db, acc, tx, cat } = setup();
    const buy = tx('2026-10-02', -299900, 'Elkjøp', 'Hus og apotek');
    expectRefund(db, buy);
    expect(listRefunds(db, '2026-10-20')[0]).toMatchObject({ amount: 299900, days: expect.any(Number), resolved_transaction_id: null });
    ingest(db, acc, [{ date: '2026-10-15', amount: 299900, description: 'Kreditering ELKJØP NORDIC', externalId: 'r1' }], 'sparebank1');
    const back = get<any>(db, "SELECT id, suggested_category_id FROM transactions WHERE external_id = 'r1'");
    expect(back.suggested_category_id).toBe(cat('Hus og apotek'));
    expect(listRefunds(db, '2026-10-20')[0].resolved_transaction_id).toBe(back.id);
  });
});
