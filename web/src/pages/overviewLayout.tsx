/**
 * Tilpass Oversikt: which cards show, in what order, and (on a PC) in which column. Saved per device, so the
 * phone and the PC can be set up differently.
 */
import { Fragment, type ReactNode } from 'react';
import { Icon } from '../components/ui';

export type CardId =
  | 'tiles'
  | 'story'
  | 'insights'
  | 'budget'
  | 'trend'
  | 'categories'
  | 'days'
  | 'payees'
  | 'accounts'
  | 'largest'
  | 'worth';
export type Zone = 'wide' | 'left' | 'right';
export interface Layout {
  items: Array<{ id: CardId; zone: Zone }>;
  hidden: CardId[];
}

export const CARDS: Record<CardId, { title: string; desc: string }> = {
  tiles: { title: 'Nøkkeltall', desc: 'Brukt, inntekt, til overs og prognose' },
  story: { title: 'Oppsummering', desc: 'Perioden forklart i én setning' },
  insights: { title: 'Innsikt', desc: 'Det som har endret seg mest' },
  budget: { title: 'Budsjett mot faktisk', desc: 'Fordelt mot brukt per kategori' },
  trend: { title: 'Utvikling', desc: 'Forbruket gjennom måneden, eller per måned' },
  categories: { title: 'Hvor pengene gikk', desc: 'Faste utgifter og hverdag, per kategori' },
  days: { title: 'Dag for dag', desc: 'Kalender, eller ukedager for lengre perioder' },
  payees: { title: 'Hvor dere handlet mest', desc: 'Butikker og steder' },
  accounts: { title: 'Per konto og kort', desc: 'Hvor pengene gikk ut fra' },
  largest: { title: 'Største kjøp', desc: 'De fem største kjøpene' },
  worth: { title: 'Formue', desc: 'Eiendeler og gjeld over tid' },
};

export const DEFAULT_LAYOUT: Layout = {
  items: [
    { id: 'tiles', zone: 'wide' },
    { id: 'story', zone: 'wide' },
    { id: 'insights', zone: 'right' },
    { id: 'budget', zone: 'right' },
    { id: 'trend', zone: 'left' },
    { id: 'categories', zone: 'left' },
    { id: 'days', zone: 'left' },
    { id: 'payees', zone: 'right' },
    { id: 'accounts', zone: 'right' },
    { id: 'largest', zone: 'right' },
    { id: 'worth', zone: 'wide' },
  ],
  hidden: [],
};

/** Tolerates old or hand-edited saved layouts: unknown cards are dropped, cards added later show up. */
export function normalize(saved: Partial<Layout> | null | undefined): Layout {
  const known = (id: unknown): id is CardId => typeof id === 'string' && id in CARDS;
  const zones: Zone[] = ['wide', 'left', 'right'];
  const seen = new Set<CardId>();
  const items: Layout['items'] = [];
  for (const it of saved?.items ?? []) {
    if (!known(it?.id) || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push({ id: it.id, zone: zones.includes(it.zone) ? it.zone : 'left' });
  }
  const hidden = (saved?.hidden ?? []).filter((id): id is CardId => known(id) && !seen.has(id));
  hidden.forEach((id) => seen.add(id));
  for (const d of DEFAULT_LAYOUT.items) if (!seen.has(d.id)) items.push(d);
  return { items, hidden };
}

/** Moves a card one step, past the nearest card it would visibly trade places with. */
export function move(layout: Layout, id: CardId, dir: -1 | 1, mobile: boolean): Layout {
  const items = [...layout.items];
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return layout;
  const me = items[i];
  // On a PC, a card in a column only changes place relative to cards in the same column or full-width ones.
  const sameSpot = (x: (typeof items)[number]) => mobile || me.zone === 'wide' || x.zone === 'wide' || x.zone === me.zone;
  let j = i + dir;
  while (j >= 0 && j < items.length && !sameSpot(items[j])) j += dir;
  if (j < 0 || j >= items.length) return layout;
  items.splice(i, 1);
  items.splice(j, 0, me);
  return { ...layout, items };
}

export function setZone(layout: Layout, id: CardId, zone: Zone): Layout {
  return { ...layout, items: layout.items.map((x) => (x.id === id ? { ...x, zone } : x)) };
}

export function hide(layout: Layout, id: CardId): Layout {
  return { items: layout.items.filter((x) => x.id !== id), hidden: [...layout.hidden, id] };
}

export function show(layout: Layout, id: CardId): Layout {
  const zone = DEFAULT_LAYOUT.items.find((x) => x.id === id)?.zone ?? 'left';
  return { items: [...layout.items, { id, zone }], hidden: layout.hidden.filter((x) => x !== id) };
}

/**
 * Lays the cards out. Full-width cards span the page; runs of column cards between them share a two-column grid.
 * On the phone everything is one column in the saved order.
 */
export function Arranged({
  layout,
  nodes,
  mobile,
  editing,
  onChange,
}: {
  layout: Layout;
  nodes: Record<CardId, ReactNode>;
  mobile: boolean;
  editing: boolean;
  onChange: (l: Layout) => void;
}) {
  const slot = (id: CardId, zone: Zone) => {
    const node = nodes[id];
    if (!editing) return node ? <Fragment key={id}>{node}</Fragment> : null;
    const list = layout.items;
    const idx = list.findIndex((x) => x.id === id);
    return (
      <div key={id} className="ov-slot">
        <div className="ov-slot-bar">
          <strong className="ellipsis">{CARDS[id].title}</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => onChange(move(layout, id, -1, mobile))} disabled={idx === 0} aria-label={`Flytt ${CARDS[id].title} opp`}>
            <Icon name="up" size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={() => onChange(move(layout, id, 1, mobile))}
            disabled={idx === list.length - 1}
            aria-label={`Flytt ${CARDS[id].title} ned`}
          >
            <Icon name="down" size={16} />
          </button>
          {!mobile && (
            <select
              className="select sm"
              value={zone}
              onChange={(e) => onChange(setZone(layout, id, e.target.value as Zone))}
              aria-label={`Plassering for ${CARDS[id].title}`}
            >
              <option value="left">Venstre</option>
              <option value="right">Høyre</option>
              <option value="wide">Full bredde</option>
            </select>
          )}
          <button className="btn ghost sm" onClick={() => onChange(hide(layout, id))}>
            <Icon name="eyeOff" size={15} /> Fjern
          </button>
        </div>
        <div className="ov-slot-body" aria-hidden>
          {node ?? <div className="card card-pad small muted">Ingenting å vise for denne perioden.</div>}
        </div>
      </div>
    );
  };

  const hiddenPicker = editing && (
    <div className="card card-pad ov-add">
      <h3 style={{ margin: 0 }}>Legg til kort</h3>
      {layout.hidden.length === 0 ? (
        <div className="small muted">Alle kortene vises. Fjern dem du ikke trenger med «Fjern».</div>
      ) : (
        <div className="ov-add-list">
          {layout.hidden.map((id) => (
            <button key={id} className="ov-add-item" onClick={() => onChange(show(layout, id))}>
              <Icon name="plus" size={16} />
              <span>
                <strong>{CARDS[id].title}</strong>
                <span className="small muted">{CARDS[id].desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (mobile) {
    return (
      <div className="stack" style={{ gap: 14 }}>
        {layout.items.map((x) => slot(x.id, x.zone))}
        {hiddenPicker}
      </div>
    );
  }

  // Group into full-width rows and two-column blocks.
  const blocks: Array<{ wide: CardId } | { left: CardId[]; right: CardId[] }> = [];
  for (const x of layout.items) {
    if (x.zone === 'wide') blocks.push({ wide: x.id });
    else {
      const last = blocks[blocks.length - 1];
      const block = last && 'left' in last ? last : (blocks[blocks.push({ left: [], right: [] }) - 1] as { left: CardId[]; right: CardId[] });
      block[x.zone].push(x.id);
    }
  }
  const zoneOf = (id: CardId) => layout.items.find((x) => x.id === id)!.zone;
  return (
    <div className="stack" style={{ gap: 16 }}>
      {blocks.map((b, i) =>
        'wide' in b ? (
          slot(b.wide, 'wide')
        ) : (
          <div key={`cols-${i}`} className="ov-grid">
            <div className="stack" style={{ gap: 16 }}>
              {b.left.map((id) => slot(id, zoneOf(id)))}
            </div>
            <div className="stack" style={{ gap: 16 }}>
              {b.right.map((id) => slot(id, zoneOf(id)))}
            </div>
          </div>
        ),
      )}
      {hiddenPicker}
    </div>
  );
}
