/**
 * Forventet inntekt in the app: a card on Budsjett with this month's pay (expected, come, still to come) and how
 * the month looks once it's in, the list on Faste regninger, and the dialog to add or change one.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type BudgetMonth, type IncomeOutlook, type IncomeStatus } from '../api';
import { dayLabel, kr, relativeDay } from '../format';
import { Icon, Modal, MoneyInput, useToast } from '../components/ui';

export interface IncomeDraft {
  id?: number;
  name: string;
  amount: number;
  day: number;
  match: string;
}

const status = (i: IncomeStatus) =>
  i.received
    ? { text: `Kommet ${dayLabel(i.received.date)}`, tone: 'good' }
    : i.status === 'late'
      ? { text: `Ventet ${dayLabel(i.expected)}, ikke sett ennå`, tone: 'warn' }
      : { text: `Ventes ${relativeDay(i.expected).toLowerCase()}`, tone: '' };

/** Budsjett: this month's pay, and the month once it's in. */
export function PayCard({ budget, onEdit, onAdd }: { budget: BudgetMonth; onEdit: (i: IncomeDraft) => void; onAdd: () => void }) {
  const e = budget.expected;
  if (!e) return null;
  if (!e.items.length)
    return (
      <div className="card card-pad pay-card">
        <h3 style={{ marginBottom: 2 }}>Forventet inntekt</h3>
        <div className="small muted">
          Legg inn hvor mye dere regner med å få, og når. Da kan dere fordele måneden før lønna kommer, og se hvordan den ligger an.
        </div>
        <button className="btn sm primary" style={{ marginTop: 10 }} onClick={onAdd}>
          <Icon name="plus" size={15} /> Legg inn lønn
        </button>
      </div>
    );
  const after = budget.readyToAssign + e.pending;
  const share = e.expected > 0 ? Math.min(1, e.received / e.expected) : 0;
  const assignedShare = e.expected > 0 ? Math.round((budget.assigned / e.expected) * 100) : null;
  return (
    <div className="card card-pad pay-card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <h3 style={{ margin: 0 }}>Lønn denne måneden</h3>
        <button className="icon-btn" onClick={onAdd} aria-label="Legg til inntekt" title="Legg til inntekt">
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div className="pay-progress">
        <div className="row small" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong className="num">{kr(e.received)}</strong> <span className="muted">av {kr(e.expected)} har kommet</span>
          </span>
          <span className="muted num">{Math.round(share * 100)} %</span>
        </div>
        <div className="bar">
          <div className="fill" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
      <div className="list compact">
        {e.items.map((i) => {
          const s = status(i);
          return (
            <button key={i.id} className="list-item pay-item" onClick={() => onEdit({ id: i.id, name: i.name, amount: i.amount, day: i.day, match: i.match })}>
              <span className={`pay-dot ${i.received ? 'in' : i.status}`} aria-hidden="true">
                {i.received ? <Icon name="check" size={12} /> : null}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="ellipsis" style={{ display: 'block', fontWeight: 550 }}>
                  {i.name}
                </span>
                <span className={`small ${s.tone === 'good' ? 'good-text' : s.tone === 'warn' ? 'warn-text' : 'muted'}`}>{s.text}</span>
              </span>
              <span className="num">{kr(i.received?.amount ?? i.amount)}</span>
            </button>
          );
        })}
      </div>
      <dl className="pay-plan">
        <div>
          <dt>Fordelt</dt>
          <dd className="num">
            {kr(budget.assigned)}
            {assignedShare !== null && <small> · {assignedShare} % av forventet</small>}
          </dd>
        </div>
        {e.pending > 0 && (
          <div>
            <dt>Ventes ennå</dt>
            <dd className="num">+{kr(e.pending)}</dd>
          </div>
        )}
        <div>
          <dt>{e.pending > 0 ? 'Klar til fordeling etter lønn' : 'Klar til fordeling'}</dt>
          <dd className={`num ${after < 0 ? 'bad-text' : 'good-text'}`}>{kr(after)}</dd>
        </div>
      </dl>
      {after < 0 && <div className="small bad-text">Selv med lønna er det fordelt {kr(-after)} for mye.</div>}
    </div>
  );
}

/** Faste regninger: the expected pay, to add and change. */
export function IncomeList({ outlook, onEdit, onAdd }: { outlook: IncomeOutlook | null; onEdit: (i: IncomeDraft) => void; onAdd: () => void }) {
  return (
    <section className="card bills-suggest">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>Inntekter</h3>
          <div className="small muted">Lønn og annet som kommer fast. Brukes til å fordele måneden på forhånd i Budsjett.</div>
        </div>
        <button className="btn sm" onClick={onAdd}>
          <Icon name="plus" size={15} /> Ny inntekt
        </button>
      </div>
      {outlook && outlook.items.length > 0 ? (
        <div className="list">
          {outlook.items.map((i) => {
            const s = status(i);
            return (
              <button key={i.id} className="list-item bill-row" onClick={() => onEdit({ id: i.id, name: i.name, amount: i.amount, day: i.day, match: i.match })}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                    {i.name}
                  </span>
                  <span className="small muted">
                    Den {i.day}. hver måned{i.match ? ` · gjenkjennes på «${i.match}»` : ' · gjenkjennes på beløpet'}
                  </span>
                  <span className={`small bill-status ${s.tone}`}>{s.text}</span>
                </span>
                <span className="bill-amount">
                  <strong className="num">{kr(i.amount)}</strong>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="small muted" style={{ marginTop: 8 }}>
          Ingen inntekter lagt inn ennå.
        </div>
      )}
    </section>
  );
}

/** Add or change an expected income. */
export function IncomeEditor({ draft, onClose, onSaved }: { draft: IncomeDraft; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState(draft);
  const set = (p: Partial<IncomeDraft>) => setD((x) => ({ ...x, ...p }));
  const save = async () => {
    try {
      if (d.id) await api.put(`/incomes/${d.id}`, d);
      else await api.post('/incomes', d);
      toast(d.id ? 'Inntekten er endret' : 'Inntekten er lagt inn');
      onSaved();
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };
  const remove = async () => {
    try {
      await api.del(`/incomes/${d.id}`);
      toast('Inntekten er fjernet');
      onSaved();
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };
  return (
    <Modal
      title={d.id ? 'Endre inntekt' : 'Ny inntekt'}
      onClose={onClose}
      footer={
        <>
          {d.id && (
            <button className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={remove}>
              Fjern
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button className="btn primary" onClick={save}>
            Lagre
          </button>
        </>
      }
    >
      <label className="field">
        Navn
        <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="f.eks. Lønn Andreas" autoFocus />
      </label>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '1 1 160px' }}>
          Forventet beløp (etter skatt)
          <MoneyInput value={d.amount} onCommit={(v) => set({ amount: v })} placeholder="f.eks. 43 500" />
        </label>
        <label className="field" style={{ flex: '1 1 120px' }}>
          Kommer den
          <select className="select" value={d.day} onChange={(e) => set({ day: Number(e.target.value) })}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}. i måneden
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Tekst fra banken (valgfritt)
        <input className="input" value={d.match} onChange={(e) => set({ match: e.target.value })} placeholder="f.eks. navnet på arbeidsgiveren" />
        <span className="help">
          Så appen ser når lønna har kommet. Står det tomt, gjenkjennes den på et beløp i nærheten av det forventede rundt datoen. Kommer den
          noen dager før, regnes den likevel med.
        </span>
      </label>
      <p className="small muted" style={{ margin: 0 }}>
        Klar til fordeling teller bare penger som har kommet. Den forventede lønna vises ved siden av, så dere kan fordele på forhånd. Se{' '}
        <Link to="/">Budsjett</Link>.
      </p>
    </Modal>
  );
}

export const newIncome = (): IncomeDraft => ({ name: 'Lønn', amount: 0, day: 25, match: '' });
