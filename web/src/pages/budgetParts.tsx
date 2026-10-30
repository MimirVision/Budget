/** Building blocks of the Budsjett tab, shared by the desktop and phone layouts. */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type BudgetMonth, type CategoryRow, type Recurring, type Transaction } from '../api';
import { dayLabel, kr, monthLabel, relativeDay } from '../format';
import { useStore } from '../store';
import { AnimatedMoney, Icon, Modal, Money, MoneyInput, haptic, useToast } from '../components/ui';
import { addMonths, currentMonth } from '../../../shared/months';

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
}: {
  cat: CategoryRow;
  month: string;
  all: CategoryRow[];
  rta: number;
  onAssign: (amount: number) => void;
  onChanged: () => Promise<void> | void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [moving, setMoving] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [recent, setRecent] = useState<Transaction[] | null>(null);

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
        <MoneyInput value={cat.assigned} onCommit={assign} className="input big-input" ariaLabel={`Fordelt til ${cat.name}`} />
      </label>
      <div className="chips">
        {quick.map((q) => (
          <button key={q.label} className="chip-btn" onClick={() => assign(q.value)}>
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
          onDone={async (text) => {
            setMoving(false);
            haptic();
            await onChanged();
            toast(text);
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
  onDone: (text: string) => void;
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
              onDone(direction === 'in' ? `Flyttet ${kr(amount)} fra ${otherName} til ${cat.name}` : `Flyttet ${kr(amount)} fra ${cat.name} til ${otherName}`);
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

export function Upcoming({ items }: { items: Recurring[] }) {
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
            Faste regninger →
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
    </section>
  );
}
