/** Building blocks of the Budsjett tab, shared by the desktop and phone layouts. */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type BudgetMonth, type CategoryRow, type Recurring, type Transaction } from '../api';
import { dayLabel, kr, monthLabel, relativeDay } from '../format';
import { useStore } from '../store';
import { useIsMobile } from '../hooks';
import { AnimatedMoney, Icon, Modal, Money, MoneyInput, haptic, useToast } from '../components/ui';
import { addMonths, currentMonth, todayISO } from '../../../shared/months';

export const CADENCE: Record<Recurring['cadence'], string> = { weekly: 'ukentlig', monthly: 'månedlig', quarterly: 'kvartalsvis', yearly: 'årlig' };

export function targetText(c: CategoryRow): { text: string; tone?: 'warn' | 'good' } | null {
  if (!c.target_type || !c.target_amount) return null;
  if (c.needed > 0) return { text: `${kr(c.needed)} mangler`, tone: 'warn' };
  if (c.target_type === 'monthly') return { text: `${kr(c.target_amount)}/mnd ✓`, tone: 'good' };
  if (c.target_type === 'balance') return { text: `Hold ${kr(c.target_amount)} ✓`, tone: 'good' };
  return { text: `${kr(c.target_amount)} innen ${monthLabel(c.target_date!).toLowerCase()} ✓`, tone: 'good' };
}

/** How much of this month's money is used, and whether that's faster than the calendar. */
export function usage(c: CategoryRow, pace: number) {
  const funds = c.available - c.activity; // what you had to spend this month
  const spent = -c.activity;
  const ratio = funds > 0 ? Math.min(1, Math.max(0, spent / funds)) : spent > 0 ? 1 : 0;
  const fast = funds > 0 && spent > 0 && pace < 1 && ratio > pace + 0.15;
  return { funds, spent, ratio, fast, show: funds > 0 || spent > 0 };
}

export function UsageBar({ c, pace }: { c: CategoryRow; pace: number }) {
  const u = usage(c, pace);
  if (!u.show) return <div className="bar bar-none" />;
  return (
    <div className="bar" title={`${Math.round(u.ratio * 100)} % brukt`}>
      <div className={`fill ${c.available < 0 ? 'bad' : u.fast ? 'warn' : ''}`} style={{ width: `${u.ratio * 100}%` }} />
      {pace > 0 && pace < 1 && <div className="pace" style={{ left: `${pace * 100}%` }} />}
    </div>
  );
}

export function subtitle(c: CategoryRow, pace: number): { text: string; tone?: 'warn' | 'good' | 'bad' } | null {
  if (c.card) {
    if (c.card.owed <= 0) return { text: 'Kortet er nedbetalt', tone: 'good' };
    const due = c.card.dueDay ? ` · forfaller ${c.card.dueDay}.` : '';
    return c.needed > 0
      ? { text: `Skylder ${kr(c.card.owed)} · mangler ${kr(c.needed)}${due}`, tone: 'warn' }
      : { text: `Skylder ${kr(c.card.owed)} · dekket ✓${due}`, tone: 'good' };
  }
  if (c.available < 0) return { text: `Overforbruk ${kr(-c.available)}`, tone: 'bad' };
  const t = targetText(c);
  if (t) return t;
  if (usage(c, pace).fast) return { text: 'Brukes raskere enn vanlig', tone: 'warn' };
  return null;
}

/** The pill that shows what's left. Re-keyed on change so it gives a little "pop". */
export function Pill({ c }: { c: CategoryRow }) {
  const cls = c.available < 0 ? 'bad' : c.needed > 0 ? 'warn' : c.available > 0 ? 'good' : 'zero';
  return (
    <span key={c.available} className={`pill ${cls} num pop`}>
      {kr(c.available)}
    </span>
  );
}

export function AutoAssignMenu({ budget, onPick, onClose }: { budget: BudgetMonth; onPick: (mode: string, label: string) => void; onClose: () => void }) {
  const needed = budget.groups.flatMap((g) => g.categories).filter((c) => !c.hidden).reduce((s, c) => s + c.needed, 0);
  const options = [
    { mode: 'targets', title: 'Fyll opp målene mine', sub: needed > 0 ? `${kr(needed)} mangler denne måneden` : 'Alle mål er dekket', label: 'Mål fylt opp' },
    { mode: 'last_month_assigned', title: 'Samme som forrige måned', sub: 'Kopier fordelingen fra forrige måned', label: 'Kopierte forrige måned' },
    { mode: 'last_month_spent', title: 'Forbruket forrige måned', sub: 'Fordel det dere faktisk brukte', label: 'Fordelte forrige måneds forbruk' },
    { mode: 'average_spent', title: 'Snittforbruk siste 3 måneder', sub: 'Jevner ut ujevne måneder', label: 'Fordelte snittforbruk' },
  ];
  return (
    <Modal title="Autofordel" onClose={onClose}>
      <p className="muted small" style={{ margin: 0 }}>
        Fordeler fra «Klar til fordeling» ({kr(budget.readyToAssign)}). Det fylles bare opp det som mangler, aldri mer enn dere har.
      </p>
      <div className="stack" style={{ gap: 8 }}>
        {options.map((o) => (
          <button key={o.mode} className="option" onClick={() => onPick(o.mode, o.label)}>
            <strong>{o.title}</strong>
            <span className="small muted">{o.sub}</span>
          </button>
        ))}
        <button
          className="btn ghost danger"
          onClick={() => confirm('Sette alle kategorier til 0 fordelt denne måneden?') && onPick('reset', 'Nullstilt')}
        >
          Nullstill denne måneden
        </button>
      </div>
    </Modal>
  );
}

/**
 * Everything about one category: what's left, quick ways to assign, targets, moving money and the latest purchases.
 * Shown in a side panel on desktop and in a bottom sheet on phones.
 */
export function CategoryDetail({
  cat,
  month,
  all,
  rta,
  onAssign,
  onChanged,
  readOnly,
}: {
  cat: CategoryRow;
  month: string;
  all: CategoryRow[];
  rta: number;
  onAssign: (amount: number) => void;
  onChanged: () => Promise<void> | void;
  /** A month before "Start på nytt": shown, but not changeable. */
  readOnly?: boolean;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [moving, setMoving] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [recent, setRecent] = useState<Transaction[] | null>(null);
  const [history, setHistory] = useState<Array<{ month: string; spent: number; assigned: number | null }> | null>(null);
  useEffect(() => {
    api.get<typeof history>(`/categories/${cat.id}/history?month=${month}&months=6`).then(setHistory).catch(() => setHistory(null));
  }, [cat.id, month, cat.activity, cat.assigned]);

  useEffect(() => {
    api.get<{ transactions: Transaction[] }>(`/transactions?category=${cat.id}&month=${month}&limit=5`).then((r) => setRecent(r.transactions));
  }, [cat.id, month, cat.activity]);

  const assign = (v: number) => {
    haptic();
    onAssign(Math.max(0, Math.round(v)));
  };
  const quick = [
    { label: '+500', value: cat.assigned + 50_000 },
    { label: '+1 000', value: cat.assigned + 100_000 },
    cat.needed > 0 && { label: 'Fyll målet', value: cat.assigned + cat.needed, hint: kr(cat.needed) },
    cat.available < 0 && { label: 'Dekk overforbruk', value: cat.assigned - cat.available, hint: kr(-cat.available) },
    cat.lastMonthAssigned > 0 && cat.lastMonthAssigned !== cat.assigned && { label: 'Som forrige mnd', value: cat.lastMonthAssigned, hint: kr(cat.lastMonthAssigned) },
    cat.avgActivity < 0 && { label: 'Snittforbruk', value: -cat.avgActivity, hint: kr(-cat.avgActivity) },
    cat.assigned !== 0 && { label: 'Nullstill', value: 0 },
  ].filter(Boolean) as Array<{ label: string; value: number; hint?: string }>;
  const carried = cat.available - cat.assigned - cat.activity;

  return (
    <div className="stack detail">
      <div>
        <div className="detail-amount" style={{ color: cat.available < 0 ? 'var(--bad)' : cat.available > 0 ? 'var(--good)' : undefined }}>
          <AnimatedMoney value={cat.available} />
        </div>
        <div className="muted small">tilgjengelig i {cat.name.toLowerCase()}</div>
      </div>
      {cat.available < 0 && (
        <div className="callout bad small">Overforbruk på {kr(-cat.available)}. Dekk det med knappen under, eller flytt penger fra en annen kategori.</div>
      )}

      <label className="field">
        Fordelt i {monthLabel(month).toLowerCase()}
        <MoneyInput value={cat.assigned} onCommit={assign} className="input big-input" ariaLabel={`Fordelt til ${cat.name}`} disabled={readOnly} />
      </label>
      <div className="chips">
        {quick.map((q) => (
          <button key={q.label} className="chip-btn" onClick={() => assign(q.value)} disabled={readOnly}>
            {q.label}
            {q.hint && <span className="faint"> {q.hint}</span>}
          </button>
        ))}
      </div>

      <div className="mini-stats">
        <div>
          <span>Fra forrige mnd</span>
          <Money value={carried} />
        </div>
        <div>
          <span>Brukt</span>
          <Money value={cat.activity} />
        </div>
        <div>
          <span>Snitt 3 mnd</span>
          <Money value={-cat.avgActivity} />
        </div>
      </div>

      {cat.target_type && cat.targetProgress !== null && (
        <div>
          <div className="row small">
            <span className="spacer muted">Mål</span>
            <span>{targetText(cat)?.text}</span>
          </div>
          <div className="bar">
            <div className="fill" style={{ width: `${cat.targetProgress * 100}%` }} />
          </div>
        </div>
      )}

      <div className="row">
        <button className="btn sm" onClick={() => setMoving(true)}>
          <Icon name="swap" size={16} /> Flytt penger
        </button>
        <button className="btn sm" onClick={() => setEditingTarget(true)}>
          <Icon name="calendar" size={16} /> {cat.target_type ? 'Endre mål' : 'Sett et mål'}
        </button>
      </div>

      {history && history.some((h) => h.spent > 0 || h.assigned) && <CategoryHistory rows={history} current={month} />}

      <div>
        <div className="row" style={{ marginBottom: 4 }}>
          <strong className="spacer small">Siste kjøp</strong>
          <button className="btn ghost sm" onClick={() => navigate(`/transactions?category=${cat.id}&month=${month}`)}>
            Se alle
          </button>
        </div>
        {recent === null ? null : recent.length === 0 ? (
          <div className="small faint">Ingen kjøp i {monthLabel(month).toLowerCase()} ennå.</div>
        ) : (
          <div className="list compact">
            {recent.map((t) => (
              <div key={t.id} className="list-item">
                <span className="grow ellipsis">{t.payee || t.raw_description}</span>
                <span className="small faint">{dayLabel(t.date)}</span>
                <Money value={t.splits.length ? t.splits.filter((s) => s.category_id === cat.id).reduce((a, s) => a + s.amount, 0) : t.amount} />
              </div>
            ))}
          </div>
        )}
      </div>

      {moving && (
        <MoveMoney
          cat={cat}
          all={all}
          rta={rta}
          month={month}
          onClose={() => setMoving(false)}
          onDone={async (text, undo) => {
            setMoving(false);
            haptic();
            await onChanged();
            toast(text, {
              action: {
                label: 'Angre',
                run: async () => {
                  await undo();
                  await onChanged();
                },
              },
            });
          }}
        />
      )}
      {editingTarget && (
        <TargetEditor
          cat={cat}
          onClose={() => setEditingTarget(false)}
          onSaved={async () => {
            setEditingTarget(false);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

export function MoveMoney({
  cat,
  all,
  rta,
  month,
  onClose,
  onDone,
}: {
  cat: CategoryRow;
  all: CategoryRow[];
  rta: number;
  month: string;
  onClose: () => void;
  onDone: (text: string, undo: () => Promise<void>) => void;
}) {
  const needsMoney = cat.available < 0 || cat.needed > 0;
  const [direction, setDirection] = useState<'in' | 'out'>(needsMoney ? 'in' : 'out');
  const [other, setOther] = useState<string>('rta');
  const [amount, setAmount] = useState(Math.max(0, cat.available < 0 ? -cat.available : cat.needed));
  const sources = all.filter((c) => c.id !== cat.id && !c.hidden);
  const otherName = other === 'rta' ? 'Klar til fordeling' : sources.find((c) => String(c.id) === other)?.name;

  return (
    <Modal
      title="Flytt penger"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button
            className="btn primary"
            disabled={amount <= 0}
            onClick={async () => {
              const o = other === 'rta' ? null : Number(other);
              const body = direction === 'in' ? { from: o, to: cat.id, amount } : { from: cat.id, to: o, amount };
              await api.post(`/budget/${month}/move`, body);
              onDone(direction === 'in' ? `Flyttet ${kr(amount)} fra ${otherName} til ${cat.name}` : `Flyttet ${kr(amount)} fra ${cat.name} til ${otherName}`, async () => {
                await api.post(`/budget/${month}/move`, { from: body.to, to: body.from, amount: body.amount });
              });
            }}
          >
            Flytt {kr(amount)}
          </button>
        </>
      }
    >
      <div className="seg">
        <button className={direction === 'in' ? 'on' : ''} onClick={() => setDirection('in')}>
          Inn i {cat.name}
        </button>
        <button className={direction === 'out' ? 'on' : ''} onClick={() => setDirection('out')}>
          Ut av {cat.name}
        </button>
      </div>
      <label className="field">
        Beløp
        <MoneyInput value={amount} onCommit={setAmount} autoFocus />
      </label>
      <label className="field">
        {direction === 'in' ? 'Ta pengene fra' : 'Gi pengene til'}
        <select className="select" value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="rta">Klar til fordeling ({kr(rta)})</option>
          {sources.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({kr(c.available)} tilgjengelig)
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}

export function TargetEditor({ cat, onClose, onSaved }: { cat: CategoryRow; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<CategoryRow['target_type']>(cat.target_type ?? 'monthly');
  const [amount, setAmount] = useState(cat.target_amount ?? 0);
  const [date, setDate] = useState(cat.target_date ?? addMonths(currentMonth(), 6));
  const save = async (clear = false) => {
    await api.patch(`/categories/${cat.id}`, clear
      ? { target_type: null, target_amount: null, target_date: null }
      : { target_type: type, target_amount: amount, target_date: type === 'by_date' ? date : null });
    onSaved();
  };
  const options: Array<{ id: NonNullable<CategoryRow['target_type']>; title: string; sub: string }> = [
    { id: 'monthly', title: 'Hver måned', sub: 'Regninger og fast forbruk: strøm, mat, Netflix' },
    { id: 'by_date', title: 'Spar til en dato', sub: 'Ferie, jul, bilforsikring som forfaller i mars' },
    { id: 'balance', title: 'Hold en saldo', sub: 'Buffer, reserve til bilen' },
  ];
  return (
    <Modal
      title={`Mål for ${cat.name}`}
      onClose={onClose}
      footer={
        <>
          {cat.target_type && (
            <button className="btn ghost danger" onClick={() => save(true)} style={{ marginRight: 'auto' }}>
              Fjern mål
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button className="btn primary" disabled={amount <= 0} onClick={() => save()}>
            Lagre mål
          </button>
        </>
      }
    >
      <div className="option-grid">
        {options.map((o) => (
          <button key={o.id} className={`option ${type === o.id ? 'on' : ''}`} onClick={() => setType(o.id)}>
            <strong>{o.title}</strong>
            <span className="small muted">{o.sub}</span>
          </button>
        ))}
      </div>
      <label className="field">
        {type === 'monthly' ? 'Beløp hver måned' : type === 'by_date' ? 'Totalt beløp du trenger' : 'Saldo som skal holdes'}
        <MoneyInput value={amount} onCommit={setAmount} autoFocus />
      </label>
      {type === 'by_date' && (
        <label className="field">
          Innen (måned)
          <input className="input" type="month" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}
    </Modal>
  );
}

interface BillRow {
  id: number;
  name: string;
  amount: number;
  due: string;
  category_name: string | null;
  paid: { date: string; amount: number } | null;
}

/**
 * Kommende regninger: your own Faste regninger when you have set them up (with whether they're paid), otherwise
 * the regular payments found in the history.
 */
export function Upcoming({ items }: { items: Recurring[] }) {
  const { version } = useStore();
  const [bills, setBills] = useState<BillRow[] | null>(null);
  useEffect(() => {
    api
      .get<{ bills: BillRow[] }>('/bills?light=1')
      .then((d) => setBills(d.bills))
      .catch(() => setBills([]));
  }, [version]);
  if (bills === null) return null;

  if (bills.length > 0) {
    const today = todayISO();
    // Unpaid first, soonest first; paid ones after, so the list says what's still coming.
    const sorted = [...bills].sort((a, b) => Number(!!a.paid) - Number(!!b.paid) || a.due.localeCompare(b.due)).slice(0, 8);
    const left = bills.filter((b) => !b.paid);
    return (
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <h3 style={{ marginBottom: 2 }}>Faste regninger</h3>
          <div className="small muted">
            {left.length ? (
              <>
                {left.length} igjen denne perioden · <Money value={-left.reduce((s, b) => s + b.amount, 0)} />
              </>
            ) : (
              'Alt er betalt denne perioden ✓'
            )}{' '}
            ·{' '}
            <Link to="/bills" style={{ color: 'var(--brand-text)', fontWeight: 600 }}>
              Se alle →
            </Link>
          </div>
        </div>
        <div className="list">
          {sorted.map((b) => (
            <div key={b.id} className={`list-item ${b.paid ? 'bill-paid' : ''}`} style={{ padding: '9px 18px' }}>
              <div className="grow">
                <div className="ellipsis" style={{ fontWeight: 500 }}>
                  {b.name}
                </div>
                <div className={`small ${b.paid ? 'good-text' : b.due < today ? 'warn-text' : 'faint'}`}>
                  {b.paid ? `Betalt ${dayLabel(b.paid.date)}` : b.due < today ? `Ikke sett ennå (${dayLabel(b.due)})` : relativeDay(b.due)}
                  {b.category_name ? <span className="faint"> · {b.category_name}</span> : null}
                </div>
              </div>
              <Money value={-b.amount} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const soon = items.filter((r) => r.amount < 0).slice(0, 8);
  if (!soon.length) return null;
  const total = soon.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <h3 style={{ marginBottom: 2 }}>Kommende regninger</h3>
        <div className="small muted">
          Funnet automatisk i historikken · <Money value={total} /> ·{' '}
          <Link to="/bills" style={{ color: 'var(--brand-text)', fontWeight: 600 }}>
            Legg dem inn som faste regninger →
          </Link>
        </div>
      </div>
      <div className="list">
        {soon.map((r) => (
          <div key={r.payee + r.nextDate} className="list-item" style={{ padding: '9px 18px' }}>
            <div className="grow">
              <div className="ellipsis" style={{ fontWeight: 500 }}>
                {r.payee}
              </div>
              <div className="small faint">
                {relativeDay(r.nextDate)} · {CADENCE[r.cadence]}
                {r.categoryName ? ` · ${r.categoryName}` : ''}
              </div>
            </div>
            <Money value={r.amount} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Attention({ budget }: { budget: BudgetMonth }) {
  const { summary } = useStore();
  const items: Array<{ tone: string; text: ReactNode }> = [];
  for (const c of summary?.attention ?? []) {
    if (c.status === 'expired')
      items.push({ tone: 'bad', text: <>Koblingen til {c.name} har utløpt. <Link to="/accounts">Koble til på nytt med BankID</Link> for å fortsette synkroniseringen.</> });
    else if (c.status === 'error') items.push({ tone: 'warn', text: <>Synkronisering av {c.name} feilet: {c.last_error}. <Link to="/accounts">Sjekk den</Link></> });
    else if (c.status === 'linking') items.push({ tone: 'info', text: <>Fullfør oppsettet av {c.name}: <Link to={`/accounts?link=${c.id}`}>velg hvilke kontoer som skal synkroniseres</Link>.</> });
    else if (c.expires_at)
      items.push({ tone: 'warn', text: <>Koblingen til {c.name} utløper {relativeDay(c.expires_at.slice(0, 10)).toLowerCase()}. <Link to="/accounts">Forny den</Link> så synkroniseringen ikke stopper.</> });
  }
  for (const c of summary?.cardAlerts ?? [])
    items.push(
      c.status === 'overdue'
        ? {
            tone: 'bad',
            text: (
              <>
                {c.name}: {kr(c.left)} av regningen er ikke betalt (forfalt {dayLabel(c.due)}). Det påløper renter
                {c.interestPerMonth ? `, ca. ${kr(c.interestPerMonth)} i måneden` : ''}. <Link to="/cards">Se kortet</Link>
              </>
            ),
          }
        : {
            tone: 'warn',
            text: (
              <>
                {c.name}-regningen på {kr(c.left)} forfaller {c.days === 0 ? 'i dag' : c.days === 1 ? 'i morgen' : `om ${c.days} dager`}
                {c.pot !== null ? (c.pot >= c.left ? '. Pengene er satt av ✓' : `. Satt av: ${kr(Math.max(0, c.pot))}`) : ''}.{' '}
                <Link to="/cards">Se kortet</Link>
              </>
            ),
          },
    );
  for (const r of summary?.lateRefunds ?? [])
    items.push({
      tone: 'warn',
      text: (
        <>
          {r.payee} har ikke betalt tilbake {kr(r.amount)} ennå ({r.days} dager). <Link to="/transactions">Se ventende refusjoner</Link>
        </>
      ),
    });
  for (const st of summary?.stale ?? []) {
    items.push({
      tone: 'warn',
      text:
        st.kind === 'nosync' ? (
          <>
            Den automatiske synkroniseringen av {st.name} har ikke kjørt siden {relativeDay(st.lastSyncAt!.slice(0, 10)).toLowerCase()}.{' '}
            <Link to="/accounts">Synkroniser nå</Link>
          </>
        ) : (
          <>
            {st.name} har ikke fått nye transaksjoner på {st.days} dager (vanligvis {st.usual === 1 ? 'hver dag' : `hver ${st.usual}. dag`}). Kanskje
            koblingen har stoppet? <Link to="/accounts">Sjekk og synkroniser</Link>
          </>
        ),
    });
  }
  if (budget.unreviewed > 0)
    items.push({
      tone: 'info',
      text: (
        <>
          <strong>{budget.unreviewed}</strong> {budget.unreviewed === 1 ? 'ny transaksjon' : 'nye transaksjoner'} å gå gjennom. <Link to="/review">Gå gjennom nå</Link>. Det tar bare et minutt.
        </>
      ),
    });
  if (!items.length) return null;
  return (
    <div className="stack" style={{ marginBottom: 16, gap: 8 }}>
      {items.map((i, idx) => (
        <div key={idx} className={`callout ${i.tone} small`}>
          <Icon name={i.tone === 'info' ? 'inbox' : 'alert'} size={18} />
          <div>{i.text}</div>
        </div>
      ))}
    </div>
  );
}

export function Welcome() {
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 20 }}>Velkommen! La oss komme i gang 👋</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Dette fungerer som YNAB: hver krone du har får en jobb. Oppsettet tar rundt fem minutter.
      </p>
      <div className="steps">
        <div className="step card">
          <div className="step-num">1</div>
          <div>
            <strong>Legg til kontoene dine</strong>
            <div className="small muted">
              Koble til bankene med BankID for automatisk synkronisering, importer en CSV-fil fra nettbanken, eller skriv inn saldoen. Du kan blande som du vil.
            </div>
            <Link to="/accounts" className="btn primary sm" style={{ marginTop: 8 }}>
              Legg til kontoer
            </Link>
          </div>
        </div>
        <div className="step card">
          <div className="step-num">2</div>
          <div>
            <strong>Gå gjennom transaksjonene</strong>
            <div className="small muted">De fleste får kategori automatisk. Du bekrefter med ett trykk, og appen lærer underveis.</div>
          </div>
        </div>
        <div className="step card">
          <div className="step-num">3</div>
          <div>
            <strong>Gi hver krone en jobb</strong>
            <div className="small muted">
              Fordel pengene på kategorier (regninger først, så hverdagsforbruk, så sparemål) til Klar til fordeling er 0.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface WrapUpData {
  month: string;
  income: number;
  spending: number;
  prevSpending: number;
  top: Array<{ name: string; spent: number; prevSpent: number }>;
  overspent: Array<{ id: number; name: string; amount: number }>;
  leftovers: Array<{ id: number; name: string; amount: number }>;
  savings: Array<{ id: number; name: string }>;
}

/** Shown at the start of a month: how last month went, and a one-tap way to sweep leftovers into savings. */
export function WrapUp({ month, startMonth, onChanged }: { month: string; startMonth: string | null; onChanged: () => void }) {
  const prev = addMonths(month, -1);
  const key = `wrapup.${prev}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const [data, setData] = useState<WrapUpData | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const show = month === currentMonth() && !hidden && (!startMonth || prev >= startMonth);

  useEffect(() => {
    if (!show) return;
    api.get<WrapUpData>(`/wrapup?month=${prev}`).then((d) => {
      setData(d);
      setTarget(d.savings[0]?.id ?? null);
      setPicked(d.leftovers.map((l) => l.id));
    });
  }, [show, prev]);

  if (!show || !data || (data.income === 0 && data.spending === 0)) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* private mode */
    }
    setHidden(true);
  };
  const saved = data.income - data.spending;
  const sweep = data.leftovers.filter((l) => picked.includes(l.id));
  const sweepTotal = sweep.reduce((s, l) => s + l.amount, 0);
  const change = data.prevSpending ? Math.round(((data.spending - data.prevSpending) / data.prevSpending) * 100) : null;

  const moveLeftovers = async () => {
    if (!target) return;
    setBusy(true);
    try {
      for (const l of sweep) await api.post(`/budget/${month}/move`, { from: l.id, to: target, amount: l.amount });
      haptic();
      toast(`Flyttet ${kr(sweepTotal)} til ${data.savings.find((s) => s.id === target)?.name}`);
      onChanged();
      dismiss();
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      <div className="wrapup-stats">
        <div>
          <span className="muted">Inn</span>
          <strong>{kr(data.income)}</strong>
        </div>
        <div>
          <span className="muted">Brukt</span>
          <strong>{kr(data.spending)}</strong>
          {change !== null && (
            <small className={change > 0 ? 'neg' : 'pos'}>
              {change > 0 ? '+' : ''}
              {change} % mot måneden før
            </small>
          )}
        </div>
        <div>
          <span className="muted">{saved >= 0 ? 'Til overs' : 'Brukt mer enn inn'}</span>
          <strong className={saved >= 0 ? 'pos' : 'neg'}>{kr(Math.abs(saved))}</strong>
        </div>
      </div>
      {data.top.length > 0 && (
        <p className="muted wrapup-line">Mest brukt på {data.top.map((t) => `${t.name} (${kr(t.spent)})`).join(', ')}.</p>
      )}
      {data.overspent.length > 0 && (
        <p className="wrapup-line neg">
          Overforbruk i{' '}
          {[...data.overspent]
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 3)
            .map((o) => `${o.name} (${kr(o.amount)})`)
            .join(', ')}
          {data.overspent.length > 3 ? ` og ${data.overspent.length - 3} til` : ''}.
        </p>
      )}
      {data.leftovers.length > 0 && data.savings.length > 0 && (
        <div className="wrapup-sweep">
          <div className="muted">Penger igjen i kategorier. Kryss av det du vil flytte til sparing:</div>
          <div className="wrapup-chips">
            {data.leftovers.map((l) => (
              <label key={l.id} className={`chip ${picked.includes(l.id) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={picked.includes(l.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))}
                />
                {l.name} · {kr(l.amount)}
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select className="select" style={{ width: 'auto' }} value={target ?? ''} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Sparekategori">
              {data.savings.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button className="btn primary" disabled={busy || sweepTotal <= 0} onClick={moveLeftovers}>
              Flytt {kr(sweepTotal)}
            </button>
          </div>
        </div>
      )}
    </>
  );

  // On the phone the summary is one tappable row that opens as a sheet, so it doesn't push the budget down.
  if (mobile) {
    return (
      <>
        <button className="card wrapup-row" onClick={() => setOpen(true)}>
          <span className="wrapup-row-icon" aria-hidden>
            <Icon name="calendar" size={18} />
          </span>
          <span className="grow" style={{ minWidth: 0 }}>
            <strong className="ellipsis" style={{ display: 'block' }}>
              Slik gikk {monthLabel(prev).split(' ')[0].toLowerCase()}
            </strong>
            <span className={`small ${saved >= 0 ? 'pos' : 'neg'}`}>
              {saved >= 0 ? `${kr(saved)} til overs` : `${kr(-saved)} mer brukt enn inn`}
              {data.leftovers.length > 0 && data.savings.length > 0 ? ' · flytt rester til sparing' : ''}
            </span>
          </span>
          <Icon name="right" size={18} />
        </button>
        {open && (
          <Modal
            title={`Slik gikk ${monthLabel(prev).toLowerCase()}`}
            onClose={() => setOpen(false)}
            footer={
              <button className="btn ghost" onClick={() => (setOpen(false), dismiss())}>
                Ikke vis igjen
              </button>
            }
          >
            <div className="wrapup sheet-body">{body}</div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <section className="card wrapup">
      <div className="wrapup-head">
        <div>
          <div className="eyebrow">Månedsoppsummering</div>
          <h3>Slik gikk {monthLabel(prev).toLowerCase()}</h3>
        </div>
        <button className="icon-btn" onClick={dismiss} aria-label="Lukk oppsummeringen">
          <Icon name="close" />
        </button>
      </div>
      {body}
    </section>
  );
}

/** Last six months for one category: bars for what was spent, a tick for what was assigned. */
function CategoryHistory({ rows, current }: { rows: Array<{ month: string; spent: number; assigned: number | null }>; current: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.spent, r.assigned ?? 0)));
  const h = rows.find((r) => r.month === hover) ?? rows.find((r) => r.month === current)!;
  const avg = Math.round(rows.filter((r) => r.month !== current).reduce((s, r) => s + r.spent, 0) / Math.max(1, rows.length - 1));
  return (
    <div className="cat-history">
      <div className="row small" style={{ marginBottom: 6 }}>
        <strong className="spacer">Siste 6 måneder</strong>
        <span className="muted">
          {monthLabel(h.month).split(' ')[0]}: brukt {kr(h.spent)}
          {h.assigned !== null ? ` av ${kr(h.assigned)}` : ''}
        </span>
      </div>
      <div className="ch-bars" role="img" aria-label={rows.map((r) => `${monthLabel(r.month)}: brukt ${kr(r.spent)}`).join(', ')}>
        {rows.map((r) => (
          <button
            key={r.month}
            className={`ch-col ${r.month === current ? 'current' : ''} ${hover === r.month ? 'on' : ''}`}
            onMouseEnter={() => setHover(r.month)}
            onMouseLeave={() => setHover(null)}
            onClick={() => setHover(hover === r.month ? null : r.month)}
            aria-label={`${monthLabel(r.month)}: brukt ${kr(r.spent)}${r.assigned !== null ? ` av ${kr(r.assigned)}` : ''}`}
          >
            <span className="ch-track">
              <span className={`ch-bar ${r.assigned !== null && r.spent > r.assigned ? 'over' : ''}`} style={{ height: `${(r.spent / max) * 100}%` }} />
              {r.assigned ? <span className="ch-tick" style={{ bottom: `${(r.assigned / max) * 100}%` }} /> : null}
            </span>
            <span className="ch-label">{monthLabel(r.month).slice(0, 3).toLowerCase()}</span>
          </button>
        ))}
      </div>
      <div className="small faint" style={{ marginTop: 4 }}>
        Søylen er brukt, streken er fordelt · snitt før denne måneden {kr(avg)}
      </div>
    </div>
  );
}

interface PaydayInfo {
  id: number;
  date: string;
  amount: number;
  payee: string;
  reviewed: number;
  category_id: number | null;
  suggested_category_id: number | null;
  category_name: string | null;
}

/**
 * Lønningsdag: when the salary has just come in, offer to give it a job in one tap. Fixed bills first, then the
 * other goals, and show what's left. Can be undone.
 */
export function Payday({ budget, month, onChanged }: { budget: BudgetMonth; month: string; onChanged: () => void }) {
  const { version } = useStore();
  const toast = useToast();
  const [pay, setPay] = useState<PaydayInfo | null>(null);
  const [billCats, setBillCats] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => {
    if (month !== currentMonth()) return;
    api.get<PaydayInfo | null>('/payday').then(setPay).catch(() => setPay(null));
    api
      .get<{ bills: Array<{ category_id: number | null }> }>('/bills?light=1')
      .then((d) => setBillCats([...new Set(d.bills.map((b) => b.category_id).filter((x): x is number => !!x))]))
      .catch(() => setBillCats([]));
  }, [month, version]);

  const key = pay ? `payday.${pay.id}` : '';
  const dismissed = (() => {
    try {
      return !!key && (hidden === key || localStorage.getItem(key) === '1');
    } catch {
      return hidden === key;
    }
  })();
  if (!pay || dismissed || month !== currentMonth()) return null;

  const cats = budget.groups.flatMap((g) => g.categories).filter((c) => !c.hidden);
  const billsNeed = cats.filter((c) => billCats.includes(c.id)).reduce((s, c) => s + c.needed, 0);
  const goalsNeed = cats.filter((c) => !billCats.includes(c.id)).reduce((s, c) => s + c.needed, 0);
  // "Klar til fordeling" only counts income with a category. A salary still waiting in Gjennomgå gets its
  // suggested category when you tap "Fordel lønna", so it's added here.
  const pool = budget.readyToAssign + (!pay.category_id && pay.suggested_category_id ? pay.amount : 0);
  const toBills = Math.min(billsNeed, Math.max(0, pool));
  const toGoals = Math.min(goalsNeed, Math.max(0, pool - toBills));
  const left = pool - toBills - toGoals;
  const dismiss = () => {
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* private mode */
    }
    setHidden(key);
  };

  const go = async () => {
    setBusy(true);
    const before = Object.fromEntries(cats.map((c) => [c.id, c.assigned]));
    try {
      if (!pay.reviewed) {
        const cat = pay.category_id ?? pay.suggested_category_id;
        if (cat) await api.patch(`/transactions/${pay.id}`, { category_id: cat, reviewed: true });
      }
      if (billCats.length) await api.post(`/budget/${month}/auto`, { mode: 'targets', categoryIds: billCats });
      const r = await api.post<{ assigned: number }>(`/budget/${month}/auto`, { mode: 'targets' });
      haptic();
      dismiss();
      onChanged();
      toast(`Lønna er fordelt: ${kr(toBills)} til regninger og ${kr(r.assigned)} til mål.`, {
        action: {
          label: 'Angre',
          run: async () => {
            await api.post(`/budget/${month}/restore`, { assigned: before });
            onChanged();
          },
        },
      });
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card payday">
      <div className="payday-head">
        <span className="payday-icon" aria-hidden>
          💰
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <strong>Lønna er kommet: {kr(pay.amount)}</strong>
          <div className="small muted ellipsis">
            {pay.payee} · {relativeDay(pay.date).toLowerCase()}
            {!pay.reviewed && pay.category_name ? ` · godkjennes som ${pay.category_name}` : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={dismiss} aria-label="Skjul">
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="payday-steps">
        <div>
          <span className="muted small">1. Faste regninger</span>
          <strong>{kr(toBills)}</strong>
        </div>
        <div>
          <span className="muted small">2. Mål</span>
          <strong>{kr(toGoals)}</strong>
        </div>
        <div>
          <span className="muted small">3. Igjen å fordele</span>
          <strong className={left < 0 ? 'neg' : ''}>{kr(left)}</strong>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        {billsNeed + goalsNeed === 0 ? (
          <span className="small muted">Alle regninger og mål er dekket. Resten kan du fordele som du vil.</span>
        ) : (
          <button className="btn primary" disabled={busy} onClick={go}>
            {busy ? 'Fordeler…' : 'Fordel lønna'}
          </button>
        )}
      </div>
    </section>
  );
}

/** Kortregninger: what each card owes, how much of it is set aside, and one tap to cover the rest. */
export function CardBills({ budget, onCover }: { budget: BudgetMonth; onCover: (c: CategoryRow) => void }) {
  const pots = budget.groups.flatMap((g) => g.categories).filter((c) => c.card && !c.hidden);
  if (!pots.length) return null;
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <h3 style={{ marginBottom: 2 }}>Kortregninger</h3>
        <div className="small muted">
          Det dere handler med kortene, settes av her automatisk ·{' '}
          <Link to="/cards" style={{ color: 'var(--brand-text)', fontWeight: 600 }}>
            Kredittkort →
          </Link>
        </div>
      </div>
      <div className="list">
        {pots.map((c) => {
          const name = c.name.replace(/^Kortregning\s+/, '');
          const pct = c.card!.owed > 0 ? Math.min(100, Math.max(0, (c.available / c.card!.owed) * 100)) : 100;
          return (
            <div key={c.id} className="list-item card-bill" style={{ padding: '10px 18px' }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                  <strong className="ellipsis">{name}</strong>
                  <Money value={-c.card!.owed} />
                </div>
                <div className="bar" style={{ margin: '6px 0 4px' }}>
                  <div className="fill" style={{ width: `${pct}%`, background: c.needed > 0 ? 'var(--warn)' : 'var(--good)' }} />
                </div>
                <div className="small muted">
                  {c.card!.owed <= 0
                    ? 'Nedbetalt ✓'
                    : c.needed > 0
                      ? `${kr(Math.max(0, c.available))} satt av · mangler ${kr(c.needed)}`
                      : `Hele regningen er satt av ✓`}
                  {c.card!.dueDay && c.card!.owed > 0 ? ` · forfaller ${c.card!.dueDay}.` : ''}
                </div>
              </div>
              {c.needed > 0 && (
                <button className="btn sm" onClick={() => onCover(c)}>
                  Dekk {kr(c.needed)}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface TipData {
  key: string;
  kind: 'price' | 'power' | 'pay';
  title: string;
  text: string;
  action?: { label: string; type: 'target' | 'move'; categoryId: number; amount: number };
}

const TIP_ICON: Record<TipData['kind'], string> = { price: '🏷️', power: '⚡', pay: '🎁' };

/** Smart tips (price increases, winter power, holiday pay): each can be acted on in one tap, or dismissed for good. */
export function Tips({ month, onChanged }: { month: string; onChanged: () => void }) {
  const { version } = useStore();
  const toast = useToast();
  const [tips, setTips] = useState<TipData[]>([]);
  const [gone, setGone] = useState<string[]>([]);
  useEffect(() => {
    if (month !== currentMonth()) return setTips([]);
    api.get<TipData[]>('/tips').then(setTips).catch(() => setTips([]));
  }, [month, version]);
  const hidden = (k: string) => {
    if (gone.includes(k)) return true;
    try {
      return localStorage.getItem(`tip.${k}`) === '1';
    } catch {
      return false;
    }
  };
  const dismiss = (k: string) => {
    try {
      localStorage.setItem(`tip.${k}`, '1');
    } catch {
      /* private mode */
    }
    setGone((g) => [...g, k]);
  };
  const shown = tips.filter((t) => !hidden(t.key));
  if (!shown.length) return null;

  const act = async (t: TipData) => {
    const a = t.action!;
    try {
      if (a.type === 'target') await api.patch(`/categories/${a.categoryId}`, { target_type: 'monthly', target_amount: a.amount });
      else await api.post(`/budget/${month}/move`, { from: null, to: a.categoryId, amount: a.amount });
      haptic();
      toast('Gjort ✓');
      dismiss(t.key);
      onChanged();
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };

  return (
    <div className="tips">
      {shown.map((t) => (
        <div key={t.key} className={`card tip tip-${t.kind}`}>
          <span className="tip-icon" aria-hidden>
            {TIP_ICON[t.kind]}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <strong>{t.title}</strong>
            <div className="small muted">{t.text}</div>
            {t.action && (
              <button className="btn sm primary" style={{ marginTop: 8 }} onClick={() => act(t)}>
                {t.action.label}
              </button>
            )}
          </div>
          <button className="icon-btn" onClick={() => dismiss(t.key)} aria-label="Skjul tipset">
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
