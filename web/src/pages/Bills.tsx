/**
 * Faste regninger: one list of the bills you know are coming. Saving a bill sets its category's monthly goal,
 * so "Sett av penger" (or Autofordel → Fyll opp målene) puts the right amount aside each month.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dayLabel, kr, relativeDay } from '../format';
import { useStore } from '../store';
import { CategorySelect, Icon, Modal, MoneyInput, Skeleton, haptic, useToast } from '../components/ui';
import { currentMonth, todayISO } from '../../../shared/months';

interface Bill {
  id: number;
  name: string;
  amount: number;
  every: number;
  due_day: number | null;
  next_due: string | null;
  category_id: number | null;
  category_name: string | null;
  match: string;
  due: string;
  monthly: number;
  paid: { date: string; amount: number } | null;
}
type Draft = Omit<Bill, 'id' | 'category_name' | 'due' | 'monthly' | 'paid'> & { id?: number };
interface Suggestion extends Draft {
  category_name: string | null;
  occurrences: number;
}
interface Data {
  bills: Bill[];
  monthlyTotal: number;
  needed: number;
  readyToAssign: number;
  suggestions: Suggestion[];
}

const EVERY: Array<{ v: number; label: string; short: string }> = [
  { v: 1, label: 'Hver måned', short: 'hver måned' },
  { v: 3, label: 'Hver 3. måned', short: 'hver 3. måned' },
  { v: 6, label: 'Hvert halvår', short: 'hvert halvår' },
  { v: 12, label: 'Hvert år', short: 'hvert år' },
];

function when(b: Bill) {
  if (b.every === 1) return `Hver måned den ${Number(b.due.slice(8, 10))}.`;
  return `${EVERY.find((e) => e.v === b.every)?.label ?? ''}, neste ${dayLabel(b.due)}`;
}

function status(b: Bill) {
  if (b.paid) return { text: `Betalt ${dayLabel(b.paid.date)}`, tone: 'good' };
  const today = todayISO();
  if (b.due < today) return { text: `Ikke sett ennå (forfalt ${dayLabel(b.due)})`, tone: 'warn' };
  return { text: `Forfaller ${relativeDay(b.due).toLowerCase()}`, tone: '' };
}

export default function BillsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const { refresh, changed } = useStore();
  const toast = useToast();

  const load = () => api.get<Data>('/bills').then(setData);
  useEffect(() => {
    load();
  }, []);
  const after = async () => {
    await load();
    await refresh();
    changed();
  };

  if (!data) return <Skeleton rows={6} />;
  const paid = data.bills.filter((b) => b.paid).length;

  const fund = async () => {
    const ids = [...new Set(data.bills.map((b) => b.category_id).filter(Boolean))];
    setBusy(true);
    try {
      const r = await api.post<{ assigned: number }>(`/budget/${currentMonth()}/auto`, { mode: 'targets', categoryIds: ids });
      haptic();
      toast(r.assigned > 0 ? `Satte av ${kr(r.assigned)} til regningene` : 'Ingenting å sette av: Klar til fordeling er tom');
      await after();
    } finally {
      setBusy(false);
    }
  };
  const addAll = async () => {
    setBusy(true);
    try {
      await api.post('/bills', data.suggestions.map(({ category_name: _c, occurrences: _o, ...s }) => s));
      haptic();
      toast(`La til ${data.suggestions.length} regninger`);
      await after();
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bills-page">
      <div className="page-head">
        <div>
          <h1>Faste regninger</h1>
          <p className="muted" style={{ margin: 0 }}>
            Det som kommer hver måned eller hvert år. Hver regning setter et månedlig mål på kategorien sin, så du vet hvor mye
            som må settes av.
          </p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ name: '', amount: 0, every: 1, due_day: null, next_due: null, category_id: null, match: '' })}>
          <Icon name="plus" size={16} /> Ny regning
        </button>
      </div>

      {data.bills.length > 0 && (
        <div className="bills-summary">
          <div className="card ov-tile">
            <span className="muted">Per måned</span>
            <strong>{kr(data.monthlyTotal)}</strong>
            <small className="faint">Årlige regninger er regnet som en tolvdel</small>
          </div>
          <div className="card ov-tile">
            <span className="muted">Betalt denne perioden</span>
            <strong>
              {paid} av {data.bills.length}
            </strong>
            <small className="faint">Sjekkes mot transaksjonene</small>
          </div>
          <div className={`card ov-tile ${data.needed > 0 ? 'need' : 'ok'}`}>
            <span className="muted">Mangler i budsjettet</span>
            <strong>{data.needed > 0 ? kr(data.needed) : 'Alt dekket ✓'}</strong>
            {data.needed > 0 && (
              <button className="btn primary sm" disabled={busy || data.readyToAssign <= 0} onClick={fund}>
                Sett av {kr(Math.min(data.needed, Math.max(0, data.readyToAssign)))}
              </button>
            )}
          </div>
        </div>
      )}

      {data.bills.length > 0 && (
        <div className="card list bills-list">
          {data.bills.map((b) => {
            const s = status(b);
            return (
              <button key={b.id} className="list-item bill-row" onClick={() => setEditing(b)}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                    {b.name}
                  </span>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>
                    {when(b)} · {b.category_name ?? <span className="warn-text">Velg kategori</span>}
                  </span>
                  <span className={`small bill-status ${s.tone}`}>{s.text}</span>
                </span>
                <span className="bill-amount">
                  <strong>{kr(b.amount)}</strong>
                  {b.every > 1 && <small className="faint">{kr(b.monthly)}/mnd</small>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {data.suggestions.length > 0 && (
        <section className="card bills-suggest">
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h3 style={{ margin: 0 }}>Funnet i transaksjonene</h3>
              <div className="small muted">Betalinger som kommer jevnlig. Sjekk beløpet og legg dem til.</div>
            </div>
            {data.suggestions.length > 1 && (
              <button className="btn sm" disabled={busy} onClick={addAll}>
                Legg til alle ({data.suggestions.length})
              </button>
            )}
          </div>
          <div className="list">
            {data.suggestions.map((s) => (
              <div key={s.name} className="list-item">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 600 }}>
                    {s.name}
                  </div>
                  <div className="small muted ellipsis">
                    {kr(s.amount)} {EVERY.find((e) => e.v === s.every)?.short} · {s.category_name ?? 'uten kategori'} · sett{' '}
                    {s.occurrences} ganger
                  </div>
                </div>
                <button className="btn sm" onClick={() => setEditing({ ...s })}>
                  Legg til
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.bills.length === 0 && data.suggestions.length === 0 && (
        <div className="card empty">
          <div className="emoji">🧾</div>
          Ingen faste regninger ennå. Legg til boliglån, strøm, forsikring og andre regninger med «Ny regning».
        </div>
      )}

      <p className="small faint" style={{ marginTop: 16 }}>
        Tips: Når regningene er lagt inn, holder det å trykke <Link to="/">Autofordel → Fyll opp målene mine</Link> i begynnelsen av
        måneden.
      </p>

      {editing && (
        <BillEditor
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            toast(msg);
            await after();
          }}
        />
      )}
    </div>
  );
}

function BillEditor({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: (msg: string) => void }) {
  const { summary } = useStore();
  const toast = useToast();
  const [d, setD] = useState<Draft>({
    ...draft,
    due_day: draft.due_day ?? (draft.next_due ? Number(draft.next_due.slice(8, 10)) : null),
  });
  const [matchTouched, setMatchTouched] = useState(!!draft.id && draft.match !== draft.name);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  const save = async () => {
    const body = { ...d, match: matchTouched ? d.match : d.name };
    try {
      if (d.id) await api.put(`/bills/${d.id}`, body);
      else await api.post('/bills', body);
      onSaved(d.id ? 'Regningen er oppdatert' : `${d.name} er lagt til`);
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };
  const remove = async () => {
    if (!d.id || !confirm(`Fjerne ${d.name}?`)) return;
    await api.del(`/bills/${d.id}`);
    onSaved('Regningen er fjernet');
  };

  return (
    <Modal
      title={d.id ? 'Endre regning' : 'Ny fast regning'}
      onClose={onClose}
      footer={
        <>
          {d.id && (
            <button className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={remove}>
              <Icon name="trash" size={16} /> Fjern
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button className="btn primary" disabled={!d.name.trim() || !d.amount} onClick={save}>
            Lagre
          </button>
        </>
      }
    >
      <label className="field">
        Navn
        <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="F.eks. Boliglån" autoFocus={!d.id} />
      </label>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>
          Beløp
          <MoneyInput value={d.amount} onCommit={(amount) => set({ amount })} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>
          Hvor ofte
          <select
            className="select"
            value={d.every}
            onChange={(e) => {
              const every = Number(e.target.value);
              set({ every, next_due: every > 1 ? d.next_due ?? todayISO() : d.next_due });
            }}
          >
            {EVERY.map((e) => (
              <option key={e.v} value={e.v}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {d.every === 1 ? (
        <label className="field">
          Forfaller den
          <select className="select" value={d.due_day ?? ''} onChange={(e) => set({ due_day: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Vet ikke</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}. i måneden
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="field">
          Neste forfall
          <input className="input" type="date" value={d.next_due ?? ''} onChange={(e) => set({ next_due: e.target.value })} />
          <span className="small faint">
            Det settes av {kr(Math.ceil(d.amount / d.every))} i måneden, så pengene er der når regningen kommer.
          </span>
        </label>
      )}
      <label className="field">
        Kategori
        <CategorySelect categories={summary?.categories ?? []} value={d.category_id} onChange={(category_id) => set({ category_id })} />
        <span className="small faint">Kategorien får et månedlig mål på summen av regningene sine.</span>
      </label>
      <label className="field">
        Tekst fra banken
        <input
          className="input"
          value={matchTouched ? d.match : d.name}
          onChange={(e) => {
            setMatchTouched(true);
            set({ match: e.target.value });
          }}
          placeholder="F.eks. Tibber"
        />
        <span className="small faint">Brukes for å se om regningen er betalt. Et ord fra mottakeren holder.</span>
      </label>
    </Modal>
  );
}
