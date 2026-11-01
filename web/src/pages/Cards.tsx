/**
 * Kredittkort: for each card, the next bill and when it's due, how long a purchase today is interest-free,
 * what paying only the minimum would cost, fees and cash withdrawals this year, and how much of the limit is used.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dayLabel, kr } from '../format';
import { useStore } from '../store';
import { Icon, Modal, MoneyInput, Skeleton, useToast } from '../components/ui';
import { dayDiff, todayISO } from '../../../shared/months';

interface Card {
  id: number;
  name: string;
  on_budget: number;
  statement_day: number | null;
  due_day: number | null;
  interest_rate: number | null;
  credit_limit: number | null;
  free_days: number | null;
  min_pay_pct: number | null;
  min_pay_kr: number | null;
  configured: boolean;
  owed: number;
  available: number | null;
  statement: { closed: string; due: string; amount: number; paid: number; left: number; status: 'paid' | 'due' | 'overdue' | 'none'; minimum: number | null; dueIsEstimate: boolean };
  current: { from: string; closes: string; spent: number; due: string };
  freeToday: { days: number; until: string };
  freeMax: number;
  bestBuyDay: number;
  minimumOnly: { monthly: number; months: number | null; interest: number } | null;
  interestPerMonth: number | null;
  feesThisYear: { total: number; items: Array<{ date: string; payee: string; amount: number }> };
  cashThisYear: { total: number; count: number };
  pot: number | null;
}

const pct = (hundredths: number | null) => (hundredths === null ? '' : (hundredths / 100).toLocaleString('nb-NO', { maximumFractionDigits: 2 }));
const years = (months: number) => {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} år` : '', m ? `${m} mnd` : ''].filter(Boolean).join(' og ') || '0 mnd';
};

export default function CardsPage() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const { version } = useStore();
  const load = () => api.get<Card[]>('/cards').then(setCards);
  useEffect(() => {
    load();
  }, [version]);

  if (!cards) return <Skeleton rows={6} />;
  return (
    <div className="cards-page">
      <div className="page-head">
        <div>
          <h1>Kredittkort</h1>
          <div className="sub">Regningen, rentefrie dager og hva det koster å ikke betale alt</div>
        </div>
      </div>
      {cards.length === 0 ? (
        <div className="card empty">
          <div className="emoji">💳</div>
          Ingen kredittkort ennå. Legg til kortet under <Link to="/accounts">Kontoer</Link> med typen «Kredittkort».
        </div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {cards.map((c) => (
            <CardPanel key={c.id} c={c} onEdit={() => setEditing(c)} />
          ))}
        </div>
      )}
      {editing && (
        <TermsEditor
          card={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function CardPanel({ c, onEdit }: { c: Card; onEdit: () => void }) {
  const today = todayISO();
  const s = c.statement;
  const daysToDue = dayDiff(today, s.due);
  const used = c.credit_limit ? Math.min(100, (c.owed / c.credit_limit) * 100) : null;
  const unused = c.credit_limit ? c.credit_limit - c.owed : 0;

  const billTone = s.status === 'overdue' ? 'bad' : s.status === 'due' && daysToDue <= 5 ? 'warn' : s.status === 'paid' ? 'good' : '';
  const billText =
    s.status === 'none'
      ? 'Ingen regning for forrige periode'
      : s.status === 'paid'
        ? `Betalt ✓ (${kr(s.amount)})`
        : s.status === 'overdue'
          ? `${kr(s.left)} ikke betalt. Forfalt ${dayLabel(s.due)}`
          : daysToDue === 0
            ? 'Forfaller i dag'
            : `Forfaller ${dayLabel(s.due)} (om ${daysToDue} ${daysToDue === 1 ? 'dag' : 'dager'})`;

  return (
    <section className="card card-pad cc">
      <div className="cc-head">
        <div className="cc-chip" aria-hidden>
          💳
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{c.name}</h3>
          <div className="small muted">
            Skylder {kr(c.owed)}
            {c.interest_rate ? ` · ${pct(c.interest_rate)} % rente` : ''}
            {c.on_budget ? '' : ' · ikke i budsjettet'}
          </div>
        </div>
        <button className="btn sm" onClick={onEdit}>
          <Icon name="edit" size={15} /> Vilkår
        </button>
      </div>

      {!c.configured && (
        <button className="callout info small cc-setup" onClick={onEdit}>
          <Icon name="alert" size={18} />
          <div style={{ textAlign: 'left' }}>
            <strong>Legg inn vilkårene for kortet</strong> (rente, fakturadato og forfall eller rentefrie dager) for riktige datoer og
            renteberegning. Du finner dem i nettbanken eller på fakturaen.
          </div>
        </button>
      )}

      <div className="cc-tiles">
        <div className={`cc-tile ${billTone}`}>
          <span className="muted small">Regning for perioden til {dayLabel(s.closed)}</span>
          <strong>{s.status === 'paid' || s.status === 'none' ? kr(0) : kr(s.left)}</strong>
          <span className="small">{billText}</span>
          {s.status !== 'paid' && s.status !== 'none' && s.minimum !== null && <span className="small faint">Minstebeløp {kr(s.minimum)}</span>}
          {s.dueIsEstimate && <span className="small faint">Forfall anslått: legg inn vilkårene</span>}
        </div>
        <div className="cc-tile">
          <span className="muted small">Denne perioden (til {dayLabel(c.current.closes)})</span>
          <strong>{kr(c.current.spent)}</strong>
          <span className="small">Betales {dayLabel(c.current.due)}</span>
        </div>
        <div className="cc-tile good">
          <span className="muted small">Handler du i dag</span>
          <strong>{c.freeToday.days} dager rentefritt</strong>
          <span className="small">Til {dayLabel(c.freeToday.until)}</span>
        </div>
      </div>

      {c.pot !== null && c.owed > 0 && (
        <div className={`small cc-line ${c.pot >= c.owed ? 'good-text' : 'warn-text'}`}>
          <Icon name="wallet" size={15} /> Satt av i Kortregning: {kr(Math.max(0, c.pot))}
          {c.pot >= c.owed ? ' (dekker alt kortet skylder ✓)' : ` (mangler ${kr(c.owed - Math.max(0, c.pot))})`}
        </div>
      )}

      {used !== null && (
        <div className="cc-limit">
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span className="muted">Kredittgrense</span>
            <span>
              {kr(c.owed)} av {kr(c.credit_limit!)} brukt
            </span>
          </div>
          <div className="bar">
            <div className="fill" style={{ width: `${used}%`, background: used > 80 ? 'var(--bad)' : used > 50 ? 'var(--warn)' : 'var(--series-1)' }} />
          </div>
        </div>
      )}

      {c.minimumOnly && c.owed > 0 && (
        <div className="cc-trap">
          <strong>Hvis dere bare betaler minstebeløpet</strong>
          <div className="small">
            {c.minimumOnly.months === null ? (
              <>Med {kr(c.minimumOnly.monthly)} i måneden blir gjelden aldri nedbetalt: rentene spiser alt.</>
            ) : (
              <>
                Med ca. {kr(c.minimumOnly.monthly)} i måneden tar det <strong>{years(c.minimumOnly.months)}</strong> å bli ferdig med{' '}
                {kr(c.owed)}, og det koster <strong>{kr(c.minimumOnly.interest)}</strong> i renter. Betaler dere hele regningen innen forfall: 0 kr.
              </>
            )}
            {c.interestPerMonth ? <> Akkurat nå tilsvarer det ca. {kr(c.interestPerMonth)} i renter per måned.</> : null}
          </div>
        </div>
      )}

      <ul className="cc-tips small">
        <li>
          <strong>Beste dag for store kjøp: den {c.bestBuyDay}.</strong> Rett etter fakturadato får kjøpet lengst rentefri tid, inntil {c.freeMax}{' '}
          dager.
        </li>
        {c.cashThisYear.count > 0 && (
          <li className="warn-text">
            {c.cashThisYear.count} kontantuttak i år ({kr(c.cashThisYear.total)}). Kontantuttak med kredittkort har som regel rente fra første dag
            og gebyr: bruk heller bankkortet.
          </li>
        )}
        {c.feesThisYear.total > 0 && (
          <li>
            Renter og gebyrer i år: <strong>{kr(c.feesThisYear.total)}</strong> ({c.feesThisYear.items.map((f) => f.payee).slice(0, 3).join(', ')}).
          </li>
        )}
        {c.credit_limit && unused >= 2000000 && (
          <li>
            Ubrukt kreditt på {kr(unused)} regnes som gjeld i Gjeldsregisteret når banken vurderer boliglån. Bruker dere sjelden så mye, kan det
            lønne seg å be om lavere grense.
          </li>
        )}
      </ul>
    </section>
  );
}

function TermsEditor({ card, onClose, onSaved }: { card: Card; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [rate, setRate] = useState(pct(card.interest_rate));
  const [limit, setLimit] = useState(card.credit_limit ?? 0);
  const [statementDay, setStatementDay] = useState<number | ''>(card.statement_day ?? '');
  const [dueDay, setDueDay] = useState<number | ''>(card.due_day ?? '');
  const [freeDays, setFreeDays] = useState(card.free_days ? String(card.free_days) : '');
  const [minPct, setMinPct] = useState(pct(card.min_pay_pct));
  const [minKr, setMinKr] = useState(card.min_pay_kr ?? 0);
  const num = (s: string) => {
    const n = Number(s.replace(',', '.').replace(/[^\d.]/g, ''));
    return s.trim() === '' || !Number.isFinite(n) ? null : n;
  };
  const days = Array.from({ length: 31 }, (_, i) => i + 1);

  const save = async () => {
    try {
      await api.patch(`/accounts/${card.id}`, {
        interest_rate: num(rate) === null ? null : Math.round(num(rate)! * 100),
        credit_limit: limit || null,
        statement_day: statementDay || null,
        due_day: dueDay || null,
        free_days: num(freeDays),
        min_pay_pct: num(minPct) === null ? null : Math.round(num(minPct)! * 100),
        min_pay_kr: minKr || null,
      });
      toast('Vilkårene er lagret');
      onSaved();
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };

  return (
    <Modal
      title={`Vilkår for ${card.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button className="btn primary" onClick={save}>
            Lagre
          </button>
        </>
      }
    >
      <p className="small muted" style={{ margin: 0 }}>
        Står på fakturaen eller i kortavtalen i nettbanken. Fyll inn det du vet; resten kan stå tomt.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Rente (nominell, % per år)
          <input className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="f.eks. 22,9" />
        </label>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Kredittgrense
          <MoneyInput value={limit} onCommit={setLimit} placeholder="f.eks. 50 000" />
        </label>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Fakturadato (perioden lukkes)
          <select className="select" value={statementDay} onChange={(e) => setStatementDay(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Siste dag i måneden</option>
            {days.map((d) => (
              <option key={d} value={d}>
                Den {d}.
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Forfall (betal innen)
          <select className="select" value={dueDay} onChange={(e) => setDueDay(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Vet ikke</option>
            {days.map((d) => (
              <option key={d} value={d}>
                Den {d}.
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Rentefrie dager («inntil … dager»)
        <input className="input" inputMode="numeric" value={freeDays} onChange={(e) => setFreeDays(e.target.value)} placeholder="f.eks. 50" />
        <span className="help">Brukes til å regne ut forfall hvis du ikke vet forfallsdatoen.</span>
      </label>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Minstebeløp (% av regningen)
          <input className="input" inputMode="decimal" value={minPct} onChange={(e) => setMinPct(e.target.value)} placeholder="f.eks. 3" />
        </label>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Men minst
          <MoneyInput value={minKr} onCommit={setMinKr} placeholder="f.eks. 300" />
        </label>
      </div>
    </Modal>
  );
}
