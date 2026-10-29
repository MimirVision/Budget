import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type BudgetMonth, type CategoryRow, type Recurring } from '../api';
import { kr, monthLabel, relativeDay } from '../format';
import { useStore } from '../store';
import { Availability, Icon, Modal, Money, MoneyInput, useToast } from '../components/ui';
import { addMonths, currentMonth } from '../../../shared/months';

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
      toast(before && before.readyToAssign <= 0 ? 'Nothing left to assign. Ready to assign is empty.' : 'Nothing needed: those categories are already covered.');
    } else if (mode !== 'reset') toast(`${label}: assigned ${kr(r.assigned)}`);
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
          <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
            <Icon name="left" />
          </button>
          <h1>{monthLabel(month)}</h1>
          <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
            <Icon name="right" />
          </button>
          {month !== currentMonth() && (
            <button className="btn sm ghost" onClick={() => setMonth(currentMonth())}>
              Today
            </button>
          )}
        </div>
        <div className="row">
          <label className="check small muted">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden
          </label>
        </div>
      </div>

      {!hasAccounts && <Welcome />}
      <Attention budget={budget} />

      <div className={`rta ${rta > 0 ? 'positive' : rta < 0 ? 'negative' : 'zero'}`}>
        <div>
          <div className="amount num">{kr(rta)}</div>
          <div className="label">
            {rta > 0 ? 'Ready to assign' : rta < 0 ? 'Assigned more than you have' : 'Every krone has a job'}
          </div>
        </div>
        <div className="small" style={{ flex: 1, minWidth: 200 }}>
          {rta > 0 && 'Give this money a job by typing amounts in the Assigned column, or let auto-assign do it.'}
          {rta < 0 && 'Take some money back from a category (lower its Assigned) until this is zero.'}
          {rta === 0 && hasAccounts && 'Nice! When the next paycheck arrives it will show up here.'}
          {month > currentMonth() && rta > 0 && ' Got paid early, like on the 20th? Assigning it to next month is exactly right.'}
        </div>
        <div style={{ position: 'relative' }}>
          <button className="btn primary" onClick={() => setAutoOpen((v) => !v)}>
            <Icon name="magic" size={16} /> Auto-assign
          </button>
          {autoOpen && (
            <div className="card" style={{ position: 'absolute', right: 0, top: 44, zIndex: 10, width: 280, padding: 6 }}>
              <AutoItem
                title="Fund my targets"
                sub={totalNeeded > 0 ? `${kr(totalNeeded)} needed this month` : 'All targets are funded'}
                onClick={() => auto('targets', 'Targets funded')}
              />
              <AutoItem title="Same as last month" sub="Copy last month's assigned amounts" onClick={() => auto('last_month_assigned', 'Copied last month')} />
              <AutoItem title="Last month's spending" sub="Assign what you actually spent" onClick={() => auto('last_month_spent', 'Assigned last month’s spending')} />
              <AutoItem title="3-month average spending" sub="Smooths out lumpy months" onClick={() => auto('average_spent', 'Assigned average spending')} />
              <AutoItem
                title="Reset this month"
                sub="Set every Assigned to zero"
                danger
                onClick={() => confirm('Set every category to 0 assigned for this month?') && auto('reset', 'Reset')}
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
                <th>Category</th>
                <th>Assigned</th>
                <th className="hide-sm">Spent</th>
                <th>Available</th>
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
            <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setAdding(true)} aria-label={`Add category to ${name}`} title="Add category">
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
              <input className="input" style={{ maxWidth: 260 }} autoFocus placeholder="New category name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button className="btn primary sm">Add</button>
              <button type="button" className="btn ghost sm" onClick={() => setAdding(false)}>
                Cancel
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
  if (c.needed > 0) return { text: `${kr(c.needed)} more needed`, tone: 'warn' };
  if (c.target_type === 'monthly') return { text: `${kr(c.target_amount)}/month ✓`, tone: 'good' };
  if (c.target_type === 'balance') return { text: `Keep ${kr(c.target_amount)} ✓`, tone: 'good' };
  return { text: `${kr(c.target_amount)} by ${monthLabel(c.target_date!)} ✓`, tone: 'good' };
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
        {!target && fast && <div className="cat-sub" style={{ color: 'var(--warn)' }}>Spending faster than usual for this point in the month</div>}
        {showBar && (
          <div className="bar" title={`${Math.round(ratio * 100)}% used`}>
            <div className={`fill ${c.available < 0 ? 'bad' : fast ? 'warn' : ''}`} style={{ width: `${ratio * 100}%` }} />
            {pace > 0 && pace < 1 && <div className="pace" style={{ left: `${pace * 100}%` }} />}
          </div>
        )}
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <MoneyInput className="assign-input" value={c.assigned} onCommit={onAssign} ariaLabel={`Assigned to ${c.name}`} />
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
    cat.needed > 0 && { label: 'Fund target', value: cat.assigned + cat.needed },
    cat.lastMonthAssigned > 0 && { label: 'Assigned last month', value: cat.lastMonthAssigned },
    cat.lastMonthActivity < 0 && { label: 'Spent last month', value: -cat.lastMonthActivity },
    cat.avgActivity < 0 && { label: 'Average spent', value: -cat.avgActivity },
    cat.available < 0 && { label: 'Cover overspending', value: cat.assigned - cat.available },
    cat.assigned !== 0 && { label: 'Clear', value: 0 },
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
        <div className="muted small">available</div>
      </div>
      {cat.available < 0 && (
        <div className="callout bad small">
          Overspent by {kr(-cat.available)}. Move money here from another category, or assign more.
        </div>
      )}
      <div>
        <div className="kv">
          <span className="muted">Left over from last month</span>
          <Money value={cat.available - cat.assigned - cat.activity} />
        </div>
        <div className="kv">
          <span className="muted">Assigned this month</span>
          <Money value={cat.assigned} />
        </div>
        <div className="kv">
          <span className="muted">Spent this month</span>
          <Money value={cat.activity} />
        </div>
        <div className="kv">
          <span className="muted">Average spent (3 mo)</span>
          <Money value={-cat.avgActivity} />
        </div>
      </div>

      {quick.length > 0 && (
        <div>
          <div className="small muted" style={{ marginBottom: 6, fontWeight: 600 }}>
            Quick assign
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
          <Icon name="swap" size={16} /> Move money
        </button>
        <button className="btn sm" onClick={() => setEditingTarget(true)}>
          <Icon name="calendar" size={16} /> {cat.target_type ? 'Edit target' : 'Set a target'}
        </button>
        <button className="btn sm ghost" onClick={() => navigate(`/transactions?category=${cat.id}&month=${month}`)}>
          Transactions
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
  const otherName = other === 'rta' ? 'Ready to assign' : sources.find((c) => String(c.id) === other)?.name;

  return (
    <Modal
      title="Move money"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={amount <= 0}
            onClick={async () => {
              const o = other === 'rta' ? null : Number(other);
              const body = direction === 'in' ? { from: o, to: cat.id, amount } : { from: cat.id, to: o, amount };
              await api.post(`/budget/${month}/move`, body);
              onDone(direction === 'in' ? `Moved ${kr(amount)} from ${otherName} to ${cat.name}` : `Moved ${kr(amount)} from ${cat.name} to ${otherName}`);
            }}
          >
            Move {kr(amount)}
          </button>
        </>
      }
    >
      <div className="seg">
        <button className={direction === 'in' ? 'on' : ''} onClick={() => setDirection('in')}>
          Into {cat.name}
        </button>
        <button className={direction === 'out' ? 'on' : ''} onClick={() => setDirection('out')}>
          Out of {cat.name}
        </button>
      </div>
      <label className="field">
        Amount
        <MoneyInput value={amount} onCommit={setAmount} autoFocus />
      </label>
      <label className="field">
        {direction === 'in' ? 'Take it from' : 'Give it to'}
        <select className="select" value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="rta">Ready to assign ({kr(rta)})</option>
          {sources.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({kr(c.available)} available)
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
    { id: 'monthly', title: 'Every month', sub: 'Bills and regular spending: power, groceries, Netflix' },
    { id: 'by_date', title: 'Save by a date', sub: 'Vacation, Christmas, car insurance due in March' },
    { id: 'balance', title: 'Keep a balance', sub: 'Emergency fund, buffer for the car' },
  ];
  return (
    <Modal
      title={`Target for ${cat.name}`}
      onClose={onClose}
      footer={
        <>
          {cat.target_type && (
            <button className="btn ghost danger" onClick={() => save(true)} style={{ marginRight: 'auto' }}>
              Remove target
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={amount <= 0} onClick={() => save()}>
            Save target
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
        {type === 'monthly' ? 'Amount each month' : type === 'by_date' ? 'Total amount needed' : 'Balance to keep'}
        <MoneyInput value={amount} onCommit={setAmount} autoFocus />
      </label>
      {type === 'by_date' && (
        <label className="field">
          By (month)
          <input className="input" type="month" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}
    </Modal>
  );
}

function MonthSummary({ budget }: { budget: BudgetMonth }) {
  return (
    <div className="card card-pad">
      <h3>This month</h3>
      <div className="kv">
        <span className="muted">Income</span>
        <Money value={budget.income} />
      </div>
      <div className="kv">
        <span className="muted">Assigned</span>
        <Money value={budget.assigned} />
      </div>
      <div className="kv">
        <span className="muted">Spent</span>
        <Money value={budget.activity} />
      </div>
      <div className="kv">
        <span className="muted">Available in categories</span>
        <Money value={budget.available} />
      </div>
      <p className="small faint" style={{ marginBottom: 0 }}>
        Tip: click a category to see its details, move money or set a target.
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
        <h3 style={{ marginBottom: 2 }}>Upcoming bills</h3>
        <div className="small muted">Found automatically from your history · <Money value={total} /></div>
      </div>
      <div className="list">
        {soon.map((r) => (
          <div key={r.payee + r.nextDate} className="list-item" style={{ padding: '9px 18px' }}>
            <div className="grow">
              <div className="ellipsis" style={{ fontWeight: 500 }}>
                {r.payee}
              </div>
              <div className="small faint">
                {relativeDay(r.nextDate)} · {r.cadence}
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
      items.push({ tone: 'bad', text: <>Your {c.name} connection has expired. <Link to="/accounts">Reconnect with BankID</Link> to keep syncing.</> });
    else if (c.status === 'error') items.push({ tone: 'warn', text: <>Syncing {c.name} failed: {c.last_error}. <Link to="/accounts">Check it</Link></> });
    else if (c.status === 'linking') items.push({ tone: 'info', text: <>Finish setting up {c.name}: <Link to={`/accounts?link=${c.id}`}>choose which accounts to sync</Link>.</> });
    else if (c.expires_at)
      items.push({ tone: 'warn', text: <>Your {c.name} connection expires {relativeDay(c.expires_at.slice(0, 10)).toLowerCase()}. <Link to="/accounts">Renew it</Link> so syncing doesn't stop.</> });
  }
  if (budget.unreviewed > 0)
    items.push({
      tone: 'info',
      text: (
        <>
          <strong>{budget.unreviewed}</strong> new transaction{budget.unreviewed === 1 ? '' : 's'} to review. <Link to="/review">Review now</Link>. It only takes a minute.
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
      <h2 style={{ fontSize: 20 }}>Welcome! Let's get you set up 👋</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        This works like YNAB: every krone you have gets a job. It takes about five minutes.
      </p>
      <div className="steps">
        <div className="step card">
          <div className="step-num">1</div>
          <div>
            <strong>Add your accounts</strong>
            <div className="small muted">
              Connect your banks with BankID for automatic sync, import a CSV from your online bank, or just type in the balance. Any mix works.
            </div>
            <Link to="/accounts" className="btn primary sm" style={{ marginTop: 8 }}>
              Add accounts
            </Link>
          </div>
        </div>
        <div className="step card">
          <div className="step-num">2</div>
          <div>
            <strong>Review your transactions</strong>
            <div className="small muted">Most get a category automatically. You confirm with one tap, and it learns as you go.</div>
          </div>
        </div>
        <div className="step card">
          <div className="step-num">3</div>
          <div>
            <strong>Give every krone a job</strong>
            <div className="small muted">
              Assign your money to categories (bills first, then everyday spending, then goals) until Ready to assign is 0.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
