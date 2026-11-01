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
  breakdown: { overdue: number; nextBill: number; unbilled: number; credit: number; accruedInterest: number | null };
  periods: Array<{ from: string; closes: string; due: string; label: string; charged: number; paid: number; left: number; status: 'open' | 'paid' | 'due' | 'overdue' }>;
  payments: Array<{ id: number; date: string; amount: number; kind: 'payment' | 'refund'; text: string; covered: Array<{ label: string; amount: number }>; extra: number }>;
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

      <OwedBreakdown c={c} />
      <PaymentHistory c={c} />

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

/** Hva dere faktisk skylder: one bar split by how urgent it is. */
function OwedBreakdown({ c }: { c: Card }) {
  const b = c.breakdown;
  const parts = [
    { key: 'overdue', label: 'Forfalt', value: b.overdue, color: 'var(--bad)', hint: b.accruedInterest ? `+ ca. ${kr(b.accruedInterest)} i renter så langt` : 'renter påløper' },
    { key: 'next', label: 'Neste regning', value: b.nextBill, color: 'var(--warn)', hint: `betales innen ${dayLabel(c.statement.due)}` },
    { key: 'unbilled', label: 'Ikke fakturert ennå', value: b.unbilled, color: 'var(--series-1)', hint: `kommer på regningen ${dayLabel(c.current.due)}` },
  ].filter((p) => p.value > 0);
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total <= 0 && b.credit <= 0) return <div className="small good-text">Kortet er nedbetalt. Dere skylder ingenting ✓</div>;
  return (
    <div className="owed">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Hva dere skylder</strong>
        <strong className="num">{kr(total)}</strong>
      </div>
      {total > 0 && (
        <div className="owed-bar" role="img" aria-label={parts.map((p) => `${p.label} ${kr(p.value)}`).join(', ')}>
          {parts.map((p) => (
            <span key={p.key} style={{ flexBasis: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${kr(p.value)}`} />
          ))}
        </div>
      )}
      <div className="owed-legend small">
        {parts.map((p) => (
          <div key={p.key}>
            <span className="swatch" style={{ background: p.color }} />
            <span>
              {p.label} <strong className="num">{kr(p.value)}</strong> <span className="faint">· {p.hint}</span>
            </span>
          </div>
        ))}
        {b.credit > 0 && (
          <div>
            <span className="swatch" style={{ background: 'var(--good)' }} />
            <span>
              Til gode på kortet <strong className="num">{kr(b.credit)}</strong> <span className="faint">· betalt inn mer enn dere skyldte</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Innbetalinger: what each payment paid down, and the billing periods behind it. */
function PaymentHistory({ c }: { c: Card }) {
  const [periods, setPeriods] = useState(false);
  if (!c.payments.length && !c.periods.length) return null;
  const list = (parts: Array<{ label: string; amount: number }>) =>
    parts.map((p, i) => (
      <span key={i}>
        {i > 0 ? (i === parts.length - 1 ? ' og ' : ', ') : ''}
        {kr(p.amount)} av {p.label}
      </span>
    ));
  return (
    <div className="cc-history">
      {c.payments.length > 0 && (
        <>
          <strong className="small">Innbetalinger og hva de dekket</strong>
          <div className="list compact">
            {c.payments.slice(0, 5).map((p) => (
              <div key={p.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="small" style={{ fontWeight: 550 }}>
                    {dayLabel(p.date)} · {p.kind === 'refund' ? `Refusjon: ${p.text}` : 'Innbetaling'}
                  </div>
                  <div className="small muted">
                    {p.covered.length ? <>Dekket {list(p.covered)}</> : 'Kortet var allerede nedbetalt'}
                    {p.extra > 0 ? `${p.covered.length ? ', og ' : ': '}${kr(p.extra)} ble til gode` : ''}.
                  </div>
                </div>
                <span className="num good-text">+{kr(p.amount)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <button className="link-btn" onClick={() => setPeriods((v) => !v)}>
        {periods ? 'Skjul regninger per periode' : 'Vis regninger per periode'}
      </button>
      {periods && (
        <table className="table cc-periods small">
          <thead>
            <tr>
              <th>Regning</th>
              <th className="right">Belastet</th>
              <th className="right">Betalt</th>
              <th className="right">Igjen</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {c.periods.map((p) => (
              <tr key={p.closes}>
                <td>
                  {p.label.replace(/^./, (x) => x.toUpperCase())}
                  <div className="faint">forfall {dayLabel(p.due)}</div>
                </td>
                <td className="right num">{kr(p.charged)}</td>
                <td className="right num">{kr(p.paid)}</td>
                <td className="right num">{kr(p.left)}</td>
                <td>
                  <span className={`chip ${p.status === 'paid' ? 'brand' : ''} ${p.status === 'overdue' ? 'bad-chip' : ''}`}>
                    {p.status === 'open' ? 'Pågår' : p.status === 'paid' ? 'Betalt ✓' : p.status === 'due' ? 'Ikke forfalt' : 'Forfalt'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
