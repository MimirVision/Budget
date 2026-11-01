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
  purchases: Purchase[];
}

interface Purchase {
  id: number;
  date: string;
  payee: string;
  amount: number;
  left: number;
  due: string;
  daysLeft: number;
  freeDays: number;
  status: 'paid' | 'free' | 'overdue';
  interest: number | null;
  billed: boolean;
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
          <Summary cards={cards} />
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
  const [more, setMore] = useState(false);
  const used = c.credit_limit ? Math.min(100, (c.owed / c.credit_limit) * 100) : null;
  const unused = c.credit_limit ? c.credit_limit - c.owed : 0;
  const s = c.statement;
  const daysToDue = dayDiff(todayISO(), s.due);

  return (
    <section className="card cc">
      <div className="cc-face">
        <div className="cc-face-top">
          <div>
            <div className="cc-face-name">{c.name}</div>
            <div className="cc-face-sub">
              {c.interest_rate ? `${pct(c.interest_rate)} % rente` : 'Rente ikke lagt inn'}
              {c.on_budget ? '' : ' · ikke i budsjettet'}
            </div>
          </div>
          <button className="btn sm cc-face-btn" onClick={onEdit}>
            <Icon name="edit" size={15} /> Vilkår
          </button>
        </div>
        <div className="cc-face-owed">
          <span>Skylder</span>
          <strong>{kr(c.owed)}</strong>
        </div>
        {used !== null && (
          <div className="cc-face-limit">
            <div className="cc-face-bar">
              <div style={{ width: `${used}%` }} />
            </div>
            <span>
              {kr(c.available ?? 0)} ledig av {kr(c.credit_limit!)}
            </span>
          </div>
        )}
      </div>

      <div className="cc-body">
        {!c.configured && (
          <button className="callout info small cc-setup" onClick={onEdit}>
            <Icon name="alert" size={18} />
            <div style={{ textAlign: 'left' }}>
              <strong>Legg inn vilkårene for kortet</strong> (rente, fakturadato og forfall eller rentefrie dager), så blir datoene og
              renteberegningen riktige.
            </div>
          </button>
        )}

        <Cycle c={c} />

        {(s.status === 'due' || s.status === 'overdue') && (
          <div className={`cc-bill ${s.status === 'overdue' ? 'bad' : daysToDue <= 5 ? 'warn' : ''}`}>
            <div className="grow">
              <strong>
                {s.status === 'overdue' ? `${kr(s.left)} er forfalt` : `Betal ${kr(s.left)} innen ${dayLabel(s.due)}`}
              </strong>
              <div className="small">
                {s.status === 'overdue'
                  ? `Renter påløper${c.breakdown.accruedInterest ? `, ca. ${kr(c.breakdown.accruedInterest)} så langt` : ''}. Betal så fort som mulig.`
                  : `${daysToDue === 0 ? 'I dag' : `Om ${daysToDue} ${daysToDue === 1 ? 'dag' : 'dager'}`} · minstebeløp ${kr(s.minimum ?? 0)}`}
                {c.pot !== null && c.owed > 0 ? ` · satt av i budsjettet: ${kr(Math.max(0, c.pot))}${c.pot >= s.left ? ' ✓' : ''}` : ''}
              </div>
            </div>
          </div>
        )}

        <OwedBreakdown c={c} />
        <Purchases c={c} />

        <button className="cc-more" onClick={() => setMore((m) => !m)} aria-expanded={more}>
          <Icon name={more ? 'up' : 'down'} size={16} /> {more ? 'Skjul' : 'Vis'} innbetalinger, regninger og tips
        </button>
        {more && (
          <div className="stack" style={{ gap: 14 }}>
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
                </div>
              </div>
            )}
            <PaymentHistory c={c} />
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
          </div>
        )}
      </div>
    </section>
  );
}

/** All cards at a glance: what's owed, the next deadline, and anything overdue. */
function Summary({ cards }: { cards: Card[] }) {
  const owed = cards.reduce((s, c) => s + c.owed, 0);
  const overdue = cards.reduce((s, c) => s + c.breakdown.overdue, 0);
  const next = cards
    .filter((c) => c.statement.status === 'due')
    .sort((a, b) => a.statement.due.localeCompare(b.statement.due))[0];
  const free = cards.flatMap((c) => c.purchases).filter((p) => p.status === 'free');
  const soonest = free.sort((a, b) => a.daysLeft - b.daysLeft)[0];
  return (
    <div className="cc-summary">
      <div className="cc-sum-tile">
        <span className="muted small">Totalt skyldig</span>
        <strong>{kr(owed)}</strong>
        <span className="small faint">
          {cards.length} {cards.length === 1 ? 'kort' : 'kort'}
        </span>
      </div>
      {overdue > 0 ? (
        <div className="cc-sum-tile bad">
          <span className="small">Forfalt</span>
          <strong>{kr(overdue)}</strong>
          <span className="small">Renter påløper. Betal så fort som mulig</span>
        </div>
      ) : (
        <div className="cc-sum-tile">
          <span className="muted small">Neste forfall</span>
          <strong>{next ? kr(next.statement.left) : 'Ingenting'}</strong>
          <span className="small faint">{next ? `${next.name} · ${dayLabel(next.statement.due)}` : 'Alle regninger er betalt ✓'}</span>
        </div>
      )}
      <div className="cc-sum-tile good">
        <span className="muted small">Rentefritt nå</span>
        <strong>{kr(free.reduce((s, p) => s + p.left, 0))}</strong>
        <span className="small faint">{soonest ? `Første frist om ${soonest.daysLeft} dager` : 'Ingen ubetalte kjøp'}</span>
      </div>
    </div>
  );
}

/** Where we are in the billing cycle: the shopping period, then the time to pay, with today marked. */
function Cycle({ c }: { c: Card }) {
  const today = todayISO();
  const start = c.current.from;
  const total = Math.max(1, dayDiff(start, c.current.due));
  const at = (d: string) => Math.min(100, Math.max(0, (dayDiff(start, d) / total) * 100));
  const closeAt = at(c.current.closes);
  const todayAt = at(today);
  const dayInPeriod = dayDiff(start, today) + 1;
  const periodDays = dayDiff(start, c.current.closes) + 1;
  const toClose = dayDiff(today, c.current.closes);
  return (
    <div className="cycle">
      <div className="cycle-text small">
        <strong>
          Dag {dayInPeriod} av {periodDays}
        </strong>{' '}
        i perioden · fakturaen lages {toClose === 0 ? 'i dag' : `om ${toClose} ${toClose === 1 ? 'dag' : 'dager'}`} · betales {dayLabel(c.current.due)}
      </div>
      <div className="cycle-track" role="img" aria-label={`Periode ${dayLabel(start)} til ${dayLabel(c.current.closes)}, forfall ${dayLabel(c.current.due)}`}>
        <span className="cycle-shop" style={{ width: `${closeAt}%` }} />
        <span className="cycle-pay" style={{ left: `${closeAt}%`, width: `${100 - closeAt}%` }} />
        <span className="cycle-today" style={{ left: `${todayAt}%` }}>
          <span>I dag</span>
        </span>
      </div>
      <div className="cycle-labels small faint">
        <span>{dayLabel(start)}</span>
        <span style={{ left: `${closeAt}%` }}>Faktura {dayLabel(c.current.closes)}</span>
        <span>Forfall {dayLabel(c.current.due)}</span>
      </div>
      <div className="cycle-legend small muted">
        <span>
          <span className="swatch" style={{ background: 'var(--series-1)' }} /> Handleperiode
        </span>
        <span>
          <span className="swatch" style={{ background: 'color-mix(in oklab, var(--series-1) 35%, var(--surface))' }} /> Tid til å betale
        </span>
      </div>
    </div>
  );
}

/** Each purchase with a countdown to when interest starts, most urgent first. */
function Purchases({ c }: { c: Card }) {
  const [all, setAll] = useState(false);
  if (!c.purchases.length) return null;
  const unpaid = c.purchases.filter((p) => p.status !== 'paid');
  const shown = all ? c.purchases : c.purchases.slice(0, 8);
  const tone = (p: Purchase) => (p.status === 'paid' ? 'paid' : p.status === 'overdue' ? 'bad' : p.daysLeft <= 6 ? 'bad' : p.daysLeft <= 20 ? 'warn' : 'good');
  return (
    <div className="cc-purchases">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Kjøp og rentefrie dager</strong>
        <span className="small muted">
          {unpaid.length} ubetalte · {kr(unpaid.reduce((s, p) => s + p.left, 0))}
        </span>
      </div>
      <div className="list">
        {shown.map((p) => {
          const t = tone(p);
          const share = p.freeDays > 0 ? Math.max(0, Math.min(1, p.daysLeft / p.freeDays)) : 0;
          return (
            <div key={p.id} className={`cc-purchase ${t}`}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', gap: 8 }}>
                  <span className="ellipsis" style={{ fontWeight: 550 }}>
                    {p.payee}
                  </span>
                  <span className="num">
                    {p.left > 0 && p.left < p.amount ? (
                      <>
                        <span className="faint" style={{ textDecoration: 'line-through', marginRight: 6 }}>
                          {kr(p.amount)}
                        </span>
                        {kr(p.left)}
                      </>
                    ) : (
                      kr(p.amount)
                    )}
                  </span>
                </div>
                <div className="small muted">
                  {dayLabel(p.date)} · {p.billed ? 'på regningen' : 'ikke fakturert ennå'} · betales innen {dayLabel(p.due)}
                </div>
                {p.status !== 'paid' && (
                  <div className="cc-countdown-bar">
                    <div style={{ width: `${p.status === 'overdue' ? 100 : share * 100}%` }} />
                  </div>
                )}
              </div>
              <div className={`cc-countdown ${t}`}>
                {p.status === 'paid' ? (
                  <>Betalt ✓</>
                ) : p.status === 'overdue' ? (
                  <>
                    <strong>{-p.daysLeft} d</strong>
                    <span>for sent{p.interest ? ` · ${kr(p.interest)} rente` : ''}</span>
                  </>
                ) : (
                  <>
                    <strong>{p.daysLeft} d</strong>
                    <span>rentefritt</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {c.purchases.length > 8 && (
        <button className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Vis færre' : `Vis alle ${c.purchases.length}`}
        </button>
      )}
      {unpaid.some((p) => p.interest) && (
        <div className="small faint">
          Betales ikke regningen i sin helhet innen forfall, beregnes renter fra kjøpsdato: ca.{' '}
          {kr(Math.round((unpaid.reduce((s, p) => s + p.left, 0) * ((c.interest_rate ?? 0) / 10000) * 7) / 365))} per uke på det som er ubetalt nå.
        </div>
      )}
    </div>
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
