import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type BudgetMonth, type CategoryRow, type Recurring } from '../api';
import { kr, monthLabel, relativeDay } from '../format';
import { useStore } from '../store';
import { Availability, Icon, Modal, Money, MoneyInput, useToast } from '../components/ui';
import { addMonths, currentMonth } from '../../../shared/months';

const CADENCE: Record<Recurring['cadence'], string> = { weekly: 'ukentlig', monthly: 'månedlig', quarterly: 'kvartalsvis', yearly: 'årlig' };

export default function BudgetPage() {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? currentMonth();
  const setMonth = (m: string) => setParams(m === currentMonth() ? {} : { month: m });
  const [budget, setBudget] = useState<BudgetMonth | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const { summary, refresh } = useStore();
  const toast = useToast();

  const load = useCallback(() => api.get<BudgetMonth>(`/budget/${month}`).then(setBudget), [month]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api.get<Recurring[]>('/recurring').then(setRecurring);
  }, []);

  const assign = async (categoryId: number, amount: number) => {
    setBudget(await api.put<BudgetMonth>(`/budget/${month}/${categoryId}`, { amount }));
    refresh();
  };

  const auto = async (mode: string, label: string, categoryIds?: number[]) => {
    const before = budget;
    const r = await api.post<{ assigned: number; budget: BudgetMonth }>(`/budget/${month}/auto`, { mode, categoryIds });
    setBudget(r.budget);
    setAutoOpen(false);
    refresh();
    if (mode !== 'reset' && r.assigned === 0) {
      toast(before && before.readyToAssign <= 0 ? 'Ingenting igjen å fordele. Klar til fordeling er tom.' : 'Ingenting mangler, kategoriene er allerede dekket.');
    } else if (mode !== 'reset') toast(`${label}: fordelte ${kr(r.assigned)}`);
  };

  const all = useMemo(() => budget?.groups.flatMap((g) => g.categories) ?? [], [budget]);
  const current = all.find((c) => c.id === selected) ?? null;

  if (!budget || !summary) return null;
  const hasAccounts = summary.accounts.length > 0;
  const totalNeeded = all.filter((c) => !c.hidden).reduce((s, c) => s + c.needed, 0);
  const rta = budget.readyToAssign;

  return (
    <>
      <div className="page-head">
        <div className="month-nav">
          <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Forrige måned">
            <Icon name="left" />
          </button>
          <h1>{monthLabel(month)}</h1>
          <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Neste måned">
            <Icon name="right" />
          </button>
          {month !== currentMonth() && (
            <button className="btn sm ghost" onClick={() => setMonth(currentMonth())}>
              I dag
            </button>
          )}
        </div>
        <div className="row">
          <label className="check small muted">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Vis skjulte
          </label>
        </div>
      </div>

      {!hasAccounts && <Welcome />}
      <Attention budget={budget} />

      <div className={`rta ${rta > 0 ? 'positive' : rta < 0 ? 'negative' : 'zero'}`}>
        <div>
          <div className="amount num">{kr(rta)}</div>
          <div className="label">
            {rta > 0 ? 'Klar til fordeling' : rta < 0 ? 'Fordelt mer enn du har' : 'Hver krone har en jobb'}
          </div>
        </div>
        <div className="small" style={{ flex: 1, minWidth: 200 }}>
          {rta > 0 && 'Gi pengene en jobb ved å skrive beløp i Fordelt-kolonnen, eller la autofordeling gjøre det.'}
          {rta < 0 && 'Ta tilbake penger fra en kategori (senk Fordelt) til dette er null.'}
          {rta === 0 && hasAccounts && 'Bra! Når neste lønn kommer, dukker den opp her.'}
          {month > currentMonth() && rta > 0 && ' Fikk du lønn tidlig, som den 20.? Da er det helt riktig å fordele den til neste måned.'}
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn primary" onClick={() => setAutoOpen((v) => !v)}>
            <Icon name="magic" size={16} /> Autofordel
          </button>
          {autoOpen && (
            <div className="card" style={{ position: 'absolute', right: 0, top: 44, zIndex: 10, width: 280, padding: 6 }}>
              <AutoItem
                title="Fyll opp målene mine"
                sub={totalNeeded > 0 ? `${kr(totalNeeded)} mangler denne måneden` : 'Alle mål er dekket'}
                onClick={() => auto('targets', 'Mål fylt opp')}
              />
              <AutoItem title="Samme som forrige måned" sub="Kopier fordelingen fra forrige måned" onClick={() => auto('last_month_assigned', 'Kopierte forrige måned')} />
              <AutoItem title="Forbruket forrige måned" sub="Fordel det du faktisk brukte" onClick={() => auto('last_month_spent', 'Fordelte forrige måneds forbruk')} />
              <AutoItem title="Snittforbruk siste 3 måneder" sub="Jevner ut ujevne måneder" onClick={() => auto('average_spent', 'Fordelte snittforbruk')} />
              <AutoItem
                title="Nullstill denne måneden"
                sub="Sett all fordeling til null"
                danger
                onClick={() => confirm('Sette alle kategorier til 0 fordelt denne måneden?') && auto('reset', 'Nullstilt')}
              />
            </div>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="budget-table">
            <thead>
              <tr>
                <th>Kategori</th>
                <th>Fordelt</th>
                <th className="hide-sm">Brukt</th>
                <th>Tilgjengelig</th>
              </tr>
            </thead>
            <tbody>
              {budget.groups
                .filter((g) => showHidden || !g.hidden)
                .map((g) => {
                  const cats = g.categories.filter((c) => showHidden || !c.hidden);
                  const sum = (k: 'assigned' | 'activity' | 'available') => cats.reduce((s, c) => s + c[k], 0);
                  return (
                    <GroupRows
                      key={g.id}
                      name={g.name}
                      groupId={g.id}
                      cats={cats}
                      totals={{ assigned: sum('assigned'), activity: sum('activity'), available: sum('available') }}
                      pace={budget.pace}
                      selected={selected}
                      onSelect={(id) => setSelected(id === selected ? null : id)}
                      onAssign={assign}
                      onAdded={load}
                    />
                  );
                })}
            </tbody>
          </table>
        </div>

        <div className="stack panel">
          {current ? (
            <CategoryPanel
              key={current.id}
              cat={current}
              month={month}
              all={all}
              rta={rta}
              onClose={() => setSelected(null)}
              onChanged={async () => {
                await load();
                refresh();
              }}
              onAssign={(amount) => assign(current.id, amount)}
            />
          ) : (
            <>
              <MonthSummary budget={budget} />
              <Upcoming items={recurring} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

function AutoItem({ title, sub, onClick, danger }: { title: string; sub: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="btn ghost"
      style={{ display: 'block', width: '100%', textAlign: 'left', height: 'auto', padding: '8px 10px', whiteSpace: 'normal' }}
    >
      <div style={{ color: danger ? 'var(--bad)' : undefined }}>{title}</div>
      <div className="small muted" style={{ fontWeight: 400 }}>
        {sub}
      </div>
    </button>
  );
}

function GroupRows({
  name,
  groupId,
  cats,
  totals,
  pace,
  selected,
  onSelect,
  onAssign,
  onAdded,
}: {
  name: string;
  groupId: number;
  cats: CategoryRow[];
  totals: { assigned: number; activity: number; available: number };
  pace: number;
  selected: number | null;
  onSelect: (id: number) => void;
  onAssign: (id: number, amount: number) => void;
  onAdded: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const { refresh } = useStore();
  return (
    <>
      <tr className="group">
        <td>
          <span className="row" style={{ gap: 4 }}>
            {name}
            <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setAdding(true)} aria-label={`Legg til kategori i ${name}`} title="Legg til kategori">
              <Icon name="plus" size={14} />
            </button>
          </span>
        </td>
        <td className="num">{kr(totals.assigned)}</td>
        <td className="num hide-sm">{kr(totals.activity)}</td>
        <td className="num">{kr(totals.available)}</td>
      </tr>
      {adding && (
        <tr>
          <td colSpan={4}>
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newName.trim()) return;
                await api.post('/categories', { name: newName, group_id: groupId });
                setNewName('');
                setAdding(false);
                onAdded();
                refresh();
              }}
            >
              <input className="input" style={{ maxWidth: 260 }} autoFocus placeholder="Navn på ny kategori" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button className="btn primary sm">Legg til</button>
              <button type="button" className="btn ghost sm" onClick={() => setAdding(false)}>
                Avbryt
              </button>
            </form>
          </td>
        </tr>
      )}
      {cats.map((c) => (
        <CategoryLine key={c.id} c={c} pace={pace} selected={selected === c.id} onSelect={() => onSelect(c.id)} onAssign={(a) => onAssign(c.id, a)} />
      ))}
    </>
  );
}

function targetText(c: CategoryRow): { text: string; tone?: 'warn' | 'good' } | null {
  if (!c.target_type || !c.target_amount) return null;
  if (c.needed > 0) return { text: `${kr(c.needed)} mangler`, tone: 'warn' };
  if (c.target_type === 'monthly') return { text: `${kr(c.target_amount)}/mnd ✓`, tone: 'good' };
  if (c.target_type === 'balance') return { text: `Hold ${kr(c.target_amount)} ✓`, tone: 'good' };
  return { text: `${kr(c.target_amount)} innen ${monthLabel(c.target_date!).toLowerCase()} ✓`, tone: 'good' };
}

function CategoryLine({
  c,
  pace,
  selected,
  onSelect,
  onAssign,
}: {
  c: CategoryRow;
  pace: number;
  selected: boolean;
  onSelect: () => void;
  onAssign: (amount: number) => void;
}) {
  const funds = c.available - c.activity; // what you had to spend this month
  const spent = -c.activity;
  const ratio = funds > 0 ? Math.min(1, Math.max(0, spent / funds)) : spent > 0 ? 1 : 0;
  const showBar = funds > 0 || spent > 0;
  const fast = funds > 0 && spent > 0 && pace < 1 && ratio > pace + 0.15;
  const target = targetText(c);
  return (
    <tr className={`cat ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <td>
        <div className="cat-name" style={{ opacity: c.hidden ? 0.5 : 1 }}>
          {c.name}
        </div>
        {target && <div className="cat-sub" style={{ color: target.tone === 'warn' ? 'var(--warn)' : undefined }}>{target.text}</div>}
        {!target && fast && <div className="cat-sub" style={{ color: 'var(--warn)' }}>Brukes raskere enn vanlig så langt i måneden</div>}
        {showBar && (
          <div className="bar" title={`${Math.round(ratio * 100)} % brukt`}>
            <div className={`fill ${c.available < 0 ? 'bad' : fast ? 'warn' : ''}`} style={{ width: `${ratio * 100}%` }} />
            {pace > 0 && pace < 1 && <div className="pace" style={{ left: `${pace * 100}%` }} />}
          </div>
        )}
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <MoneyInput className="assign-input" value={c.assigned} onCommit={onAssign} ariaLabel={`Fordelt til ${c.name}`} />
      </td>
      <td className="num hide-sm muted">{c.activity ? kr(c.activity) : '–'}</td>
      <td>
        <Availability value={c.available} needed={c.needed} />
      </td>
    </tr>
  );
}

function CategoryPanel({
  cat,
  month,
  all,
  rta,
  onClose,
  onChanged,
  onAssign,
}: {
  cat: CategoryRow;
  month: string;
  all: CategoryRow[];
  rta: number;
  onClose: () => void;
  onChanged: () => void;
  onAssign: (amount: number) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [moving, setMoving] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);

  const quick = [
    cat.needed > 0 && { label: 'Fyll opp målet', value: cat.assigned + cat.needed },
    cat.lastMonthAssigned > 0 && { label: 'Fordelt forrige måned', value: cat.lastMonthAssigned },
    cat.lastMonthActivity < 0 && { label: 'Brukt forrige måned', value: -cat.lastMonthActivity },
    cat.avgActivity < 0 && { label: 'Snittforbruk', value: -cat.avgActivity },
    cat.available < 0 && { label: 'Dekk overforbruket', value: cat.assigned - cat.available },
    cat.assigned !== 0 && { label: 'Nullstill', value: 0 },
  ].filter(Boolean) as Array<{ label: string; value: number }>;

  return (
    <div className="card card-pad stack">
      <div className="row">
        <h3 style={{ margin: 0, flex: 1 }}>{cat.name}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <div>
        <div className={`big num`} style={{ color: cat.available < 0 ? 'var(--bad)' : cat.available > 0 ? 'var(--good)' : undefined }}>
          {kr(cat.available)}
        </div>
        <div className="muted small">tilgjengelig</div>
      </div>
      {cat.available < 0 && (
        <div className="callout bad small">
          Overforbruk på {kr(-cat.available)}. Flytt penger hit fra en annen kategori, eller fordel mer.
        </div>
      )}
      <div>
        <div className="kv">
          <span className="muted">Overført fra forrige måned</span>
          <Money value={cat.available - cat.assigned - cat.activity} />
        </div>
        <div className="kv">
          <span className="muted">Fordelt denne måneden</span>
          <Money value={cat.assigned} />
        </div>
        <div className="kv">
          <span className="muted">Brukt denne måneden</span>
          <Money value={cat.activity} />
        </div>
        <div className="kv">
          <span className="muted">Snittforbruk (3 mnd)</span>
          <Money value={-cat.avgActivity} />
        </div>
      </div>

      {quick.length > 0 && (
        <div>
          <div className="small muted" style={{ marginBottom: 6, fontWeight: 600 }}>
            Hurtigfordeling
          </div>
          <div className="quick">
            {quick.map((q) => (
              <button key={q.label} onClick={() => onAssign(q.value)}>
                {q.label}
                <strong className="num">{kr(q.value)}</strong>
              </button>
            ))}
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
        <button className="btn sm ghost" onClick={() => navigate(`/transactions?category=${cat.id}&month=${month}`)}>
          Transaksjoner
        </button>
      </div>

      {cat.target_type && cat.targetProgress !== null && (
        <div>
          <div className="small muted">{targetText(cat)?.text}</div>
          <div className="bar">
            <div className="fill" style={{ width: `${cat.targetProgress * 100}%` }} />
          </div>
        </div>
      )}

      {moving && (
        <MoveMoney
          cat={cat}
          all={all}
          rta={rta}
          onClose={() => setMoving(false)}
          onDone={async (text) => {
            setMoving(false);
            await onChanged();
            toast(text);
          }}
          month={month}
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

function MoveMoney({
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

function TargetEditor({ cat, onClose, onSaved }: { cat: CategoryRow; onClose: () => void; onSaved: () => void }) {
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

function MonthSummary({ budget }: { budget: BudgetMonth }) {
  return (
    <div className="card card-pad">
      <h3>Denne måneden</h3>
      <div className="kv">
        <span className="muted">Inntekt</span>
        <Money value={budget.income} />
      </div>
      <div className="kv">
        <span className="muted">Fordelt</span>
        <Money value={budget.assigned} />
      </div>
      <div className="kv">
        <span className="muted">Brukt</span>
        <Money value={budget.activity} />
      </div>
      <div className="kv">
        <span className="muted">Tilgjengelig i kategorier</span>
        <Money value={budget.available} />
      </div>
      <p className="small faint" style={{ marginBottom: 0 }}>
        Tips: klikk på en kategori for å se detaljer, flytte penger eller sette et mål.
      </p>
    </div>
  );
}

function Upcoming({ items }: { items: Recurring[] }) {
  const soon = items.filter((r) => r.amount < 0).slice(0, 8);
  if (!soon.length) return null;
  const total = soon.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <h3 style={{ marginBottom: 2 }}>Kommende regninger</h3>
        <div className="small muted">Funnet automatisk i historikken · <Money value={total} /></div>
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

function Attention({ budget }: { budget: BudgetMonth }) {
  const { summary } = useStore();
  const items: Array<{ tone: string; text: React.ReactNode }> = [];
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

function Welcome() {
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
