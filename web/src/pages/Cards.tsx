/**
 * Kredittkort. One answer first: what to pay, and by when, so nothing costs interest (pick any date). Then the
 * purchases with their interest-free days, the bills and payments, and insight, each in its own tab.
 * The numbers start from the bank's own bill and balance when the app has them (entered, from a CSV or a sync).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dayLabel as fullDay, kr } from '../format';
import { useStore } from '../store';
import { Icon, Modal, MoneyInput, Skeleton, useToast } from '../components/ui';
import { addDays, dayDiff, todayISO } from '../../../shared/months';
import { payToStayFree, whatIfPay } from '../../../shared/cardplan';
import { Rings } from '../components/apple';
import { closesAround, dueFor } from '../../../shared/carddates';

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
  guessed: { statementDay: boolean; due: boolean };
  owed: number;
  available: number | null;
  statement: {
    closed: string;
    due: string;
    amount: number;
    paid: number;
    left: number;
    status: 'paid' | 'due' | 'overdue' | 'none';
    minimum: number | null;
    dueIsEstimate: boolean;
    fromBank: boolean;
  };
  bank: {
    statement: BankStatement | null;
    newer: boolean;
    appOwed: number;
    balance: { owed: number; date: string; source: 'manual' | 'csv' | 'sync' } | null;
  };
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
  periods: Array<{ from: string; closes: string; due: string; label: string; charged: number; paid: number; left: number; status: 'open' | 'paid' | 'due' | 'overdue'; fromBank: boolean }>;
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
  bill: string;
  closes: string;
  kind: 'purchase' | 'unknown' | 'opening';
  cashLike: boolean;
}

interface BankStatement {
  id: number;
  closed: string;
  due: string;
  amount: number;
  minimum: number | null;
  balance: number | null;
  balance_date: string | null;
}

/** "20. nov" (without the abbreviation dot, so sentences can end after it). */
const dayLabel = (d: string) => fullDay(d).replace(/\.$/, '');
const cap = (s: string) => s.replace(/^./, (x) => x.toUpperCase());
const days = (n: number) => `${n} ${Math.abs(n) === 1 ? 'dag' : 'dager'}`;
const pct = (hundredths: number | null) => (hundredths === null ? '' : (hundredths / 100).toLocaleString('nb-NO', { maximumFractionDigits: 2 }));
const years = (months: number) => {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} år` : '', m ? `${m} mnd` : ''].filter(Boolean).join(' og ') || '0 mnd';
};
const when = (d: string) => {
  const n = dayDiff(todayISO(), d);
  return n === 0 ? 'i dag' : n === 1 ? 'i morgen' : n > 0 ? `om ${days(n)}` : `${days(-n)} siden`;
};
const SOURCE = { manual: 'lagt inn', csv: 'fra CSV', sync: 'fra banken' } as const;

export default function CardsPage() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const [billFor, setBillFor] = useState<Card | null>(null);
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
          <div className="sub">Hva som må betales, og når, for å slippe renter</div>
        </div>
      </div>
      {cards.length === 0 ? (
        <div className="card empty">
          <div className="emoji">💳</div>
          Ingen kredittkort ennå. Legg til kortet under <Link to="/accounts">Kontoer</Link> med typen «Kredittkort».
        </div>
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          {cards.length > 1 && <Total cards={cards} />}
          {cards.map((c) => (
            <CardPanel key={c.id} c={c} onEdit={() => setEditing(c)} onBill={() => setBillFor(c)} onChanged={load} />
          ))}
        </div>
      )}
      {billFor && (
        <StatementEditor
          card={billFor}
          onClose={() => setBillFor(null)}
          onSaved={() => {
            setBillFor(null);
            load();
          }}
        />
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

/** All cards in one line: what's owed, and the next deadline. */
function Total({ cards }: { cards: Card[] }) {
  const owed = cards.reduce((s, c) => s + c.owed, 0);
  const overdue = cards.reduce((s, c) => s + c.breakdown.overdue, 0);
  const next = cards
    .filter((c) => c.statement.status === 'due')
    .sort((a, b) => a.statement.due.localeCompare(b.statement.due))[0];
  return (
    <div className="cc-total">
      <div>
        <span className="muted small">Totalt skyldig</span>
        <strong className="num">{kr(owed)}</strong>
      </div>
      {overdue > 0 ? (
        <div className="bad-text">
          <span className="small">Forfalt</span>
          <strong className="num">{kr(overdue)}</strong>
        </div>
      ) : (
        <div>
          <span className="muted small">Neste frist</span>
          <strong className="num">{next ? `${kr(next.statement.left)} · ${dayLabel(next.statement.due)}` : 'Alt betalt ✓'}</strong>
        </div>
      )}
    </div>
  );
}

type Tab = 'buys' | 'bills' | 'insight';

function CardPanel({ c, onEdit, onBill, onChanged }: { c: Card; onEdit: () => void; onBill: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('buys');
  const used = c.credit_limit ? Math.min(100, (c.owed / c.credit_limit) * 100) : null;
  const source = c.bank.balance
    ? `Saldo ${SOURCE[c.bank.balance.source]} ${dayLabel(c.bank.balance.date)}`
    : c.bank.statement
      ? `Regning fra banken ${dayLabel(c.bank.statement.closed)}`
      : 'Beregnet fra transaksjonene';
  const unpaid = c.purchases.filter((p) => p.status !== 'paid').length;

  return (
    <section className="card cc">
      <div className="cc-face">
        <div className="cc-face-top">
          <div className="cc-ident">
            <span className="mini-card" aria-hidden="true">
              <i />
            </span>
            <div style={{ minWidth: 0 }}>
            <div className="cc-face-name">{c.name}</div>
            <div className="cc-face-sub">{source}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <button className="btn sm cc-face-btn" onClick={onBill}>
              <Icon name="bank" size={15} /> Oppdater
            </button>
            <button className="btn sm cc-face-btn icon-only" onClick={onEdit} aria-label="Vilkår for kortet">
              <Icon name="settings" size={15} />
            </button>
          </div>
        </div>
        <div className="cc-face-row">
          <div className="cc-face-owed">
            <span>Skyldig</span>
            <strong>{kr(c.owed)}</strong>
          </div>
          <div className="cc-pay">
            {(() => {
              const bill = c.statement.amount;
              const share = bill > 0 ? Math.min(1, c.statement.paid / bill) : 1;
              const left = dayDiff(todayISO(), c.statement.due);
              const owing = c.statement.left > 0;
              return (
                <Rings
                  size={68}
                  stroke={7}
                  rings={[{ value: owing ? share : 1, color: c.statement.status === 'overdue' ? 'var(--bad)' : 'var(--good)' }]}
                  label={owing ? `${Math.round(share * 100)} % av regningen betalt, ${left} dager til forfall` : 'Regningen er betalt'}
                >
                  {owing ? (
                    <>
                      <strong className="num">{Math.abs(left)}</strong>
                      <span>{left < 0 ? 'dg. sent' : 'dager'}</span>
                    </>
                  ) : (
                    <strong>✓</strong>
                  )}
                </Rings>
              );
            })()}
          </div>
          <dl className="cc-face-facts">
            <div>
              <dt>Neste betaling</dt>
              <dd className="num">{c.statement.left > 0 ? kr(c.statement.left) : 'Ingen'}</dd>
            </div>
            <div>
              <dt>Frist</dt>
              <dd className={c.statement.status === 'overdue' ? 'bad-text' : ''}>
                {c.statement.left > 0 ? `${dayLabel(c.statement.due)}${c.statement.status === 'overdue' ? ' (forfalt)' : ''}` : '–'}
              </dd>
            </div>
            <div>
              <dt>Periode nå</dt>
              <dd>
                {dayLabel(c.current.from)}–{dayLabel(c.current.closes)}
              </dd>
            </div>
            <div>
              <dt>Rentefritt for kjøp i dag</dt>
              <dd>{days(c.freeToday.days)}</dd>
            </div>
          </dl>
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
        <Answer c={c} onEdit={onEdit} />
        <Notes c={c} onBill={onBill} onEdit={onEdit} onChanged={onChanged} />

        <div className="seg cc-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'buys'} className={tab === 'buys' ? 'on' : ''} onClick={() => setTab('buys')}>
            Kjøp{unpaid ? ` (${unpaid})` : ''}
          </button>
          <button role="tab" aria-selected={tab === 'bills'} className={tab === 'bills' ? 'on' : ''} onClick={() => setTab('bills')}>
            Regninger
          </button>
          <button role="tab" aria-selected={tab === 'insight'} className={tab === 'insight' ? 'on' : ''} onClick={() => setTab('insight')}>
            Innsikt
          </button>
        </div>
        {tab === 'buys' && <Purchases c={c} />}
        {tab === 'bills' && <Bills c={c} />}
        {tab === 'insight' && <Insight c={c} onEdit={onEdit} />}
      </div>
    </section>
  );
}

/**
 * The answer: "nothing should cost interest up to and including [date]: pay X by Y". The date defaults to the
 * next deadline; any date can be picked. Below it: what a smaller (or bigger) payment would cover.
 */
function Answer({ c, onEdit }: { c: Card; onEdit: () => void }) {
  const today = todayISO();
  const unpaid = c.periods.filter((p) => p.left > 0);
  const dues = [...new Set(unpaid.map((p) => p.due))].sort();
  const firstUpcoming = dues.find((d) => d >= today);
  const [until, setUntil] = useState(firstUpcoming ?? today);
  const [custom, setCustom] = useState(false);
  const [whatIf, setWhatIf] = useState(false);
  const [amount, setAmount] = useState(0);

  if (!unpaid.length || c.owed <= 0)
    return (
      <div className="cc-answer good">
        <strong className="cc-answer-big">Alt er betalt ✓</strong>
        <div className="small">
          {c.breakdown.credit > 0 ? `${kr(c.breakdown.credit)} til gode på kortet. ` : ''}Kjøp i dag er rentefritt til {dayLabel(c.freeToday.until)} (
          {days(c.freeToday.days)}).
        </div>
      </div>
    );

  const plan = payToStayFree(c.periods, until, today);
  const guessed = c.guessed.statementDay || c.guessed.due;
  const guessNote = guessed && (
    <div className="cc-guess small">
      <Icon name="alert" size={15} />
      <span>
        <strong>Fristene er anslått.</strong> Appen vet ikke {c.guessed.statementDay && c.guessed.due ? 'fakturadato og forfall' : c.guessed.statementDay ? 'fakturadatoen' : 'forfallsdagen'}{' '}
        for kortet, så den regner med {c.guessed.statementDay ? 'faktura ved månedsslutt' : ''}
        {c.guessed.statementDay && c.guessed.due ? ' og ' : ''}
        {c.guessed.due ? 'forfall 20 dager etter' : ''}.{' '}
        <button className="link-btn" onClick={onEdit}>
          Legg inn datoene
        </button>
      </span>
    </div>
  );
  const overdue = plan.steps.some((s) => s.overdue);
  const what = whatIf && amount > 0 ? whatIfPay(c.periods, amount, today) : null;
  const short = dayLabel;

  return (
    <div className={`cc-answer ${overdue ? 'bad' : plan.total === 0 ? 'good' : ''}`}>
      <div className="cc-answer-q small">
        <span>Rentefritt til og med</span>
        <div className="cc-answer-dates">
          {dues
            .filter((d) => d >= today)
            .slice(0, 3)
            .map((d) => (
              <button key={d} className={`chip-btn ${!custom && until === d ? 'on' : ''}`} onClick={() => (setUntil(d), setCustom(false))}>
                {short(d)}
              </button>
            ))}
          {custom ? (
            <input
              className="input cc-date"
              type="date"
              value={until}
              min={today}
              autoFocus
              onChange={(e) => e.target.value && setUntil(e.target.value)}
              aria-label="Velg dato"
            />
          ) : (
            <button className="chip-btn" onClick={() => setCustom(true)}>
              Annen dato…
            </button>
          )}
        </div>
      </div>

      {guessNote}
      {plan.total === 0 ? (
        <>
          <strong className="cc-answer-big">Ingenting å betale før {dayLabel(until)}</strong>
          {plan.later && (
            <div className="small">
              Neste frist: {kr(plan.later.amount)}
              {plan.later.open ? ' så langt' : ''} innen {dayLabel(plan.later.due)}.
            </div>
          )}
        </>
      ) : (
        <>
          <div className="cc-answer-line">
            <strong className="cc-answer-big num">Betal {kr(plan.total)}</strong>
            <span>{overdue ? 'nå: noe er forfalt og koster renter' : `innen ${dayLabel(plan.payBy!)} · ${when(plan.payBy!)}`}</span>
          </div>
          {plan.steps.length > 1 && (
            <ul className="cc-answer-steps small">
              {plan.steps.map((st) => (
                <li key={st.closes}>
                  <span>
                    {cap(st.label)}
                    {st.open ? <span className="muted"> · så langt</span> : ''}
                  </span>
                  <span className="num">
                    {kr(st.amount)} <span className="muted">· {st.overdue ? 'forfalt' : dayLabel(st.due)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="small muted">
            {[
              overdue && c.breakdown.accruedInterest ? `ca. ${kr(c.breakdown.accruedInterest)} i renter så langt` : null,
              plan.growing ? 'nye kjøp før perioden lukkes kommer i tillegg' : null,
              plan.later ? `deretter ${kr(plan.later.amount)}${plan.later.open ? ' så langt' : ''} innen ${dayLabel(plan.later.due)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
              .replace(/^./, (x) => x.toUpperCase())}
          </div>
        </>
      )}

      <div className="cc-answer-facts small">
        {c.statement.minimum !== null && c.statement.left > 0 && <span>Minstebeløp {kr(c.statement.minimum)}</span>}
        {c.pot !== null && (
          <span className={c.pot >= plan.total ? 'good-text' : ''}>
            Satt av {kr(Math.max(0, c.pot))}
            {c.pot >= plan.total && plan.total > 0 ? ' ✓' : ''}
          </span>
        )}
        <span>Kjøp i dag: rentefritt {days(c.freeToday.days)}</span>
        <button className="link-btn" onClick={() => setWhatIf((v) => !v)}>
          {whatIf ? 'Skjul' : 'Hva om vi betaler…'}
        </button>
      </div>
      {whatIf && (
        <div className="cc-whatif">
          <MoneyInput value={amount} onCommit={setAmount} placeholder="Beløp" ariaLabel="Beløp vi betaler" autoFocus />
          <div className="small">
            {!what ? (
              <span className="muted">Skriv et beløp, så ser du hva det dekker.</span>
            ) : what.next ? (
              <>
                {what.cleared.length > 0 && <>Dekker {what.cleared.map((b) => b.label).join(' og ')}. </>}
                Da gjenstår <strong>{kr(what.next.left)}</strong> av {what.next.label},{' '}
                {what.next.overdue ? 'som allerede er forfalt' : `som må betales innen ${dayLabel(what.next.due)}`}.
              </>
            ) : (
              <>Alt er betalt{what.extra > 0 ? `, og ${kr(what.extra)} blir til gode` : ''} ✓</>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** At most a few short lines about what would make the numbers better, each with its fix. */
function Notes({ c, onBill, onEdit, onChanged }: { c: Card; onBill: () => void; onEdit: () => void; onChanged: () => void }) {
  const toast = useToast();
  const exact = !!c.bank.statement || !!c.bank.balance;
  const diff = c.bank.appOwed - c.owed;
  const match = async () => {
    try {
      await api.post(`/cards/${c.id}/match-balance`);
      toast('Saldoen i Kontoer er justert. Gi justeringen en kategori i Gjennomgå.');
      onChanged();
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };
  const notes: Array<{ key: string; text: string; action: string; run: () => void; warn?: boolean }> = [];
  if (!exact)
    notes.push({
      key: 'bank',
      text: 'Tallene er beregnet fra transaksjonene. Legg inn regningen, eller importer en CSV med saldo, for eksakte tall.',
      action: 'Legg inn',
      run: onBill,
    });
  else if (c.bank.newer)
    notes.push({ key: 'newer', text: `Ny regning ble laget ${dayLabel(c.statement.closed)}.`, action: 'Legg den inn', run: onBill, warn: true });
  if (!c.interest_rate)
    notes.push({ key: 'terms', text: 'Legg inn renten, så ser du hva det koster å betale for sent.', action: 'Vilkår', run: onEdit });
  if (exact && Math.abs(diff) >= 100)
    notes.push({ key: 'match', text: `Kontoer viser ${kr(c.bank.appOwed)} skyldig, banken ${kr(c.owed)}.`, action: 'Juster Kontoer', run: match });
  if (!notes.length) return null;
  return (
    <div className="cc-notes small">
      {notes.map((n) => (
        <div key={n.key} className={n.warn ? 'warn-text' : 'muted'}>
          <span>{n.text}</span>
          <button className="link-btn" onClick={n.run}>
            {n.action}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Every purchase, grouped by the bill it's on. On a Norwegian card the interest-free deadline belongs to the
 * bill: everything on it must be paid by its due date. So the countdown is shown once per bill, and each
 * purchase shows how many interest-free days it got in total (an early purchase gets more than a late one).
 */
function Purchases({ c }: { c: Card }) {
  const [showPaid, setShowPaid] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!c.purchases.length) return <div className="small muted cc-empty">Ingen kjøp siden forrige regning.</div>;
  const paidCount = c.purchases.filter((p) => p.status === 'paid').length;
  const groups = new Map<string, Purchase[]>();
  for (const p of c.purchases) if (showPaid || p.status !== 'paid') groups.set(p.closes, [...(groups.get(p.closes) ?? []), p]);
  const ordered = [...groups.entries()].sort((a, b) => a[1][0].due.localeCompare(b[1][0].due));
  const guessed = c.guessed.statementDay || c.guessed.due;
  const LIMIT = 10;
  return (
    <div className="cc-purchases">
      {ordered.map(([closes, list]) => {
        const first = list[0];
        const unpaid = list.filter((p) => p.status !== 'paid');
        const left = unpaid.reduce((s, p) => s + p.left, 0);
        const daysLeft = first.daysLeft;
        const overdue = unpaid.length > 0 && daysLeft < 0;
        const tone = !unpaid.length ? 'paid' : overdue || daysLeft <= 6 ? 'bad' : daysLeft <= 20 ? 'warn' : 'good';
        const shown = open[closes] || list.length <= LIMIT + 2 ? list : list.slice(0, LIMIT);
        return (
          <div key={closes} className="cc-group">
            <div className="cc-group-head">
              <div className="grow" style={{ minWidth: 0 }}>
                <strong>{cap(first.bill)}</strong>
                <div className="small muted">
                  {unpaid.length
                    ? `${kr(left)} må betales innen ${dayLabel(first.due)}${guessed ? ' (anslått)' : ''}`
                    : `Betalt ✓ · forfall ${dayLabel(first.due)}`}
                  {!first.billed ? ` · lukkes ${dayLabel(closes)}, nye kjøp før det kommer i tillegg` : ''}
                </div>
              </div>
              {unpaid.length > 0 && (
                <div className={`cc-days big ${tone}`}>
                  <strong>{overdue ? -daysLeft : daysLeft}</strong>
                  <span>{overdue ? (-daysLeft === 1 ? 'dag for sent' : 'dager for sent') : daysLeft === 0 ? 'siste dag' : daysLeft === 1 ? 'dag igjen' : 'dager igjen'}</span>
                </div>
              )}
            </div>
            {shown.map((p) => (
              <div key={p.id} className={`cc-row ${p.status === 'paid' ? 'paid' : ''}`}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className={`ellipsis ${p.kind !== 'purchase' ? 'cc-estimated' : ''}`}>{p.payee}</div>
                  <div className="small muted">
                    {p.kind === 'unknown'
                      ? 'Fra bankens tall: ikke en transaksjon appen har'
                      : p.kind === 'opening'
                        ? 'Gjeld fra før appen'
                        : `${dayLabel(p.date)} · ${p.freeDays} rentefrie dager`}
                    {p.status === 'paid' ? ' · betalt' : p.left < p.amount ? ` · ${kr(p.left)} igjen` : ''}
                  </div>
                  {p.cashLike && p.status !== 'paid' && (
                    <div className="small warn-text">Påfyll/uttak: mange banker tar rente fra første dag og gebyr på dette</div>
                  )}
                </div>
                <span className="num cc-row-amount">{kr(p.amount)}</span>
              </div>
            ))}
            {shown.length < list.length && (
              <button className="link-btn" onClick={() => setOpen((o) => ({ ...o, [closes]: true }))}>
                Vis alle {list.length}
              </button>
            )}
          </div>
        );
      })}
      <div className="row small muted" style={{ justifyContent: 'space-between' }}>
        <span>Rentefristen gjelder hele regningen. Innbetalinger går til eldste regning først.</span>
        {paidCount > 0 && (
          <button className="link-btn" onClick={() => setShowPaid((v) => !v)}>
            {showPaid ? 'Skjul betalte' : `Vis betalte (${paidCount})`}
          </button>
        )}
      </div>
    </div>
  );
}

/** The bills, newest first, and the payments with what each one covered. */
function Bills({ c }: { c: Card }) {
  const status = { open: 'Pågår', paid: 'Betalt ✓', due: 'Til betaling', overdue: 'Forfalt' } as const;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="cc-list">
        {c.periods.map((p) => (
          <div key={p.closes} className="cc-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div>
                {cap(p.label)}
                {p.fromBank && <span className="chip cc-chip">fra banken</span>}
              </div>
              <div className="small muted">
                {p.status === 'open' ? `Lukkes ${dayLabel(p.closes)}` : `Forfall ${dayLabel(p.due)}`} · {kr(p.charged)}
                {p.paid > 0 ? ` · betalt ${kr(p.paid)}` : ''}
              </div>
            </div>
            <div className="right">
              <div className="num">{kr(p.left)}</div>
              <div className={`small ${p.status === 'overdue' ? 'bad-text' : p.status === 'paid' ? 'good-text' : 'muted'}`}>{status[p.status]}</div>
            </div>
          </div>
        ))}
      </div>
      {c.payments.length > 0 && (
        <div className="cc-list">
          <strong className="small">Innbetalinger</strong>
          {c.payments.map((p) => (
            <div key={p.id} className="cc-row">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{p.kind === 'refund' ? `Refusjon: ${p.text}` : p.id < 0 ? p.text : 'Innbetaling'}</div>
                <div className="small muted">
                  {dayLabel(p.date)} ·{' '}
                  {p.covered.length ? p.covered.map((x) => `${kr(x.amount)} til ${x.label}`).join(', ') : 'kortet var allerede nedbetalt'}
                  {p.extra > 0 ? ` · ${kr(p.extra)} til gode` : ''}
                </div>
              </div>
              <span className="num good-text">+{kr(p.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The cycle, the cost of paying only the minimum, fees, and the card's terms. */
function Insight({ c, onEdit }: { c: Card; onEdit: () => void }) {
  const toClose = dayDiff(todayISO(), c.current.closes);
  const unused = c.credit_limit ? c.credit_limit - c.owed : 0;
  const facts: Array<{ title: string; text: ReactNode; tone?: 'warn' | 'bad' }> = [
    {
      title: 'Perioden nå',
      text: (
        <>
          {dayLabel(c.current.from)} til {dayLabel(c.current.closes)} (fakturaen lages {toClose === 0 ? 'i dag' : `om ${days(toClose)}`}), betales{' '}
          {dayLabel(c.current.due)}. Kjøp rett etter fakturadato får lengst rentefri tid: inntil {c.freeMax} dager.
        </>
      ),
    },
  ];
  if (c.minimumOnly && c.owed > 0)
    facts.push({
      title: 'Bare minstebeløpet?',
      tone: 'warn',
      text:
        c.minimumOnly.months === null ? (
          <>Med {kr(c.minimumOnly.monthly)} i måneden blir gjelden aldri nedbetalt: rentene spiser alt.</>
        ) : (
          <>
            Ca. {kr(c.minimumOnly.monthly)} i måneden tar <strong>{years(c.minimumOnly.months)}</strong> og koster{' '}
            <strong>{kr(c.minimumOnly.interest)}</strong> i renter. Hele regningen innen forfall: 0 kr.
          </>
        ),
    });
  if (c.interestPerMonth && c.owed > 0)
    facts.push({ title: 'Renter hvis det ikke betales', text: <>Ca. {kr(c.interestPerMonth)} i måneden på det som skyldes nå.</> });
  if (c.feesThisYear.total > 0)
    facts.push({
      title: 'Renter og gebyrer i år',
      text: (
        <>
          {kr(c.feesThisYear.total)} ({c.feesThisYear.items.map((f) => f.payee).slice(0, 3).join(', ')}).
        </>
      ),
    });
  const cashLike = c.purchases.filter((p) => p.cashLike && p.status !== 'paid');
  if (cashLike.length)
    facts.push({
      title: 'Påfyll og uttak på kortet',
      tone: 'warn',
      text: (
        <>
          {kr(cashLike.reduce((s, p) => s + p.left, 0))} ubetalt ({[...new Set(cashLike.map((p) => p.payee.split(',')[0].trim()))].slice(0, 2).join(', ')}). Påfyll
          av Revolut og lignende regnes ofte som kontantuttak: rente fra første dag og gebyr, uansett forfall. Sjekk vilkårene eller fakturaen.
        </>
      ),
    });
  if (c.cashThisYear.count > 0)
    facts.push({
      title: 'Kontantuttak',
      tone: 'bad',
      text: (
        <>
          {c.cashThisYear.count} i år ({kr(c.cashThisYear.total)}). Har som regel rente fra første dag og gebyr: bruk bankkortet.
        </>
      ),
    });
  if (c.credit_limit && unused >= 2000000)
    facts.push({
      title: 'Ubrukt kreditt',
      text: <>{kr(unused)} regnes som gjeld i Gjeldsregisteret ved boliglån. Bruker dere sjelden så mye, kan lavere grense lønne seg.</>,
    });
  return (
    <div className="stack" style={{ gap: 10 }}>
      {facts.map((f) => (
        <div key={f.title} className={`cc-fact ${f.tone ?? ''}`}>
          <strong className="small">{f.title}</strong>
          <div className="small">{f.text}</div>
        </div>
      ))}
      <div className="cc-terms small muted">
        <span>
          {c.interest_rate ? `${pct(c.interest_rate)} % rente` : 'Rente ikke lagt inn'}
          {c.free_days ? ` · inntil ${c.free_days} rentefrie dager` : ''}
          {c.due_day ? ` · forfall den ${c.due_day}.` : ''}
        </span>
        <button className="link-btn" onClick={onEdit}>
          Endre vilkår
        </button>
      </div>
    </div>
  );
}

/** Legg inn regningen: the amount to pay and the dates, as the bank's bill says. Optionally the balance now. */
function StatementEditor({ card, onClose, onSaved }: { card: Card; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const prev = card.bank.statement;
  const fresh = !prev || card.bank.newer;
  const [amount, setAmount] = useState(fresh ? 0 : prev!.amount);
  const [due, setDue] = useState(fresh ? card.statement.due : prev!.due);
  const [closed, setClosed] = useState(fresh ? card.statement.closed : prev!.closed);
  const [minimum, setMinimum] = useState(fresh ? 0 : prev!.minimum ?? 0);
  const [withBalance, setWithBalance] = useState(!fresh && prev!.balance !== null);
  const [balance, setBalance] = useState(!fresh && prev!.balance !== null ? prev!.balance : 0);
  const [balanceDate, setBalanceDate] = useState(!fresh && prev!.balance_date ? prev!.balance_date : todayISO());

  const save = async () => {
    try {
      await api.post(`/cards/${card.id}/statement`, {
        closed,
        due,
        amount,
        minimum: minimum || null,
        balance: withBalance ? balance : null,
        balance_date: withBalance ? balanceDate : null,
      });
      toast('Regningen er lagt inn. Kortet regnes nå ut fra den');
      onSaved();
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };
  const remove = async () => {
    try {
      await api.del(`/cards/${card.id}/statement/${prev!.id}`);
      toast('Regningen er fjernet. Appen regner ut fra transaksjonene igjen');
      onSaved();
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };

  return (
    <Modal
      title={`Oppdater ${card.name} fra banken`}
      onClose={onClose}
      footer={
        <>
          {prev && !fresh && (
            <button className="btn ghost danger" onClick={remove} style={{ marginRight: 'auto' }}>
              Fjern
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button className="btn primary" onClick={save} disabled={!closed || !due || (withBalance && !balance)}>
            Lagre
          </button>
        </>
      }
    >
      <p className="small muted" style={{ margin: 0 }}>
        Fra fakturaen eller nettbanken. Beløpet blir stående som fasit for denne regningen; alt etter fakturadatoen regnes ut fra transaksjonene.
      </p>
      <label className="field">
        Å betale (hele regningen)
        <MoneyInput value={amount} onCommit={setAmount} placeholder="f.eks. 4 812,50" autoFocus />
      </label>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Forfallsdato
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Fakturadato
          <input className="input" type="date" value={closed} max={todayISO()} onChange={(e) => setClosed(e.target.value)} />
        </label>
      </div>
      <label className="field">
        Minstebeløp (valgfritt)
        <MoneyInput value={minimum} onCommit={setMinimum} placeholder="står på fakturaen" />
      </label>
      {card.bank.balance && card.bank.balance.source !== 'manual' && (
        <div className="callout info small">
          <Icon name="bank" size={16} />
          <span>
            Saldoen {SOURCE[card.bank.balance.source]} {dayLabel(card.bank.balance.date)} ({kr(card.bank.balance.owed)}) brukes automatisk. Importer en ny CSV
            for å oppdatere den.
          </span>
        </div>
      )}
      <label className="check small">
        <input type="checkbox" checked={withBalance} onChange={(e) => setWithBalance(e.target.checked)} />
        <span>
          <strong>Skriv inn saldoen nå</strong>
          <span className="muted"> · totalen banken sier dere skylder i dag, også det som ikke er fakturert</span>
        </span>
      </label>
      {withBalance && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 140px' }}>
            Saldo (skyldig)
            <MoneyInput value={balance} onCommit={setBalance} placeholder="fra nettbanken" />
          </label>
          <label className="field" style={{ flex: '1 1 140px' }}>
            Per dato
            <input className="input" type="date" value={balanceDate} min={closed} max={todayISO()} onChange={(e) => setBalanceDate(e.target.value)} />
          </label>
        </div>
      )}
    </Modal>
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

  // What these dates mean, right now: which purchases land on which bill, and when each must be paid.
  const dates = { statement_day: statementDay || null, due_day: dueDay || null, free_days: num(freeDays) };
  const today = todayISO();
  const { last, next } = closesAround(today, dates.statement_day);
  const after = closesAround(addDays(next, 1), dates.statement_day).next;
  const bills = [
    { from: addDays(last, 1), closes: next, ...dueFor(next, last, dates) },
    { from: addDays(next, 1), closes: after, ...dueFor(after, next, dates) },
  ];

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
          Fakturadato
          <select className="select" value={statementDay} onChange={(e) => setStatementDay(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Siste dag i måneden</option>
            {days.map((d) => (
              <option key={d} value={d}>
                Den {d}.
              </option>
            ))}
          </select>
          <span className="help">Siste dag med kjøp på en regning.</span>
        </label>
        <label className="field" style={{ flex: '1 1 140px' }}>
          Forfallsdato
          <select className="select" value={dueDay} onChange={(e) => setDueDay(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Vet ikke</option>
            {days.map((d) => (
              <option key={d} value={d}>
                Den {d}.
              </option>
            ))}
          </select>
          <span className="help">Betal hele regningen innen denne dagen.</span>
        </label>
      </div>
      {!dueDay && (
        <label className="field">
          Eller: rentefrie dager («inntil … dager»)
          <input className="input" inputMode="numeric" value={freeDays} onChange={(e) => setFreeDays(e.target.value)} placeholder="f.eks. 50" />
          <span className="help">Brukes bare når forfallsdatoen ikke er kjent: forfall = inntil så mange dager fra periodens første dag.</span>
        </label>
      )}
      <div className="cc-terms-preview small">
        <strong>Slik blir det:</strong>
        {bills.map((b) => (
          <div key={b.closes}>
            Kjøp {dayLabel(b.from)}–{dayLabel(b.closes)} betales innen <strong>{dayLabel(b.due)}</strong>
            {b.estimate ? ' (anslått)' : ''} · {dayDiff(b.closes, b.due)}–{dayDiff(b.from, b.due)} rentefrie dager
          </div>
        ))}
        {card.bank.statement && <div className="muted">Fakturadatoen fra regningen du la inn ({dayLabel(card.bank.statement.closed)}) brukes foran denne.</div>}
      </div>
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

