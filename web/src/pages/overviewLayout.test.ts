import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, hide, move, normalize, setZone, show } from './overviewLayout';

const ids = (l: { items: Array<{ id: string }> }) => l.items.map((x) => x.id);

describe('Tilpass Oversikt', () => {
  it('fills in cards a saved layout doesn’t know about, and drops unknown ones', () => {
    const l = normalize({ items: [{ id: 'worth', zone: 'wide' }, { id: 'nope' as any, zone: 'left' }], hidden: ['tiles'] });
    expect(ids(l)[0]).toBe('worth');
    expect(ids(l)).not.toContain('tiles');
    expect(ids(l)).not.toContain('nope');
    expect(l.items.length + l.hidden.length).toBe(DEFAULT_LAYOUT.items.length);
  });

  it('removes and adds back', () => {
    const l = hide(normalize(null), 'payees');
    expect(ids(l)).not.toContain('payees');
    expect(l.hidden).toEqual(['payees']);
    const back = show(l, 'payees');
    expect(ids(back).at(-1)).toBe('payees');
    expect(back.hidden).toEqual([]);
  });

  it('on a PC, moving within a column skips cards in the other column', () => {
    const l = normalize(null); // ... trend(left), cashflow(left), categories(left) ...
    const up = move(l, 'categories', -1, false);
    expect(ids(up).indexOf('categories')).toBeLessThan(ids(up).indexOf('cashflow'));
    const r = move(l, 'payees', -1, false); // right column: passes over the left-column cards before it
    expect(ids(r).indexOf('payees')).toBeLessThan(ids(r).indexOf('days'));
    expect(ids(r)[ids(r).indexOf('payees') + 1]).toBe('budget'); // and lands just before the previous right-column card
  });

  it('changes column', () => {
    expect(setZone(normalize(null), 'worth', 'left').items.find((x) => x.id === 'worth')?.zone).toBe('left');
  });
});
