/**
 * Budsjett: where you manage the money. Give every krone a job, see what's left in each category, fix overspending.
 * Desktop: a dense table with a detail panel on the right. Phone: tappable cards with a bottom sheet.
 */
import { Rings, Tile, groupTint } from '../components/apple';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type BudgetMonth, type CategoryRow, type Recurring } from '../api';
import { kr, monthLabel } from '../format';
import { useStore } from '../store';
import { useIsMobile, useStoredState } from '../hooks';
import { AnimatedMoney, Icon, Modal, MoneyInput, Skeleton, haptic, useToast } from '../components/ui';
import { addMonths, currentMonth } from '../../../shared/months';
import { Attention, AutoAssignMenu, CardBills, Payday, Tips, WrapUp, CategoryDetail, Pill, Upcoming, UsageBar, Welcome, subtitle, usage } from './budgetParts';

type Filter = 'all' | 'needs' | 'over' | 'money';
const FILTERS: Array<{ id: Filter; label: string; test: (c: CategoryRow) => boolean }> = [
  { id: 'all', label: 'Alle', test: () => true },
  { id: 'needs', label: 'Mangler', test: (c) => c.needed > 0 },
  { id: 'over', label: 'Overforbrukt', test: (c) => c.available < 0 },
  { id: 'money', label: 'Har penger', test: (c) => c.available > 0 },
];

export default function BudgetPage() {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? currentMonth();
  const setMonth = (m: string) => setParams(m === currentMonth() ? {} : { month: m });
  const [budget, setBudget] = useState<BudgetMonth | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [collapsed, setCollapsed] = useStoredState<number[]>('budget.collapsed', []);
  const [autoOpen, setAutoOpen] = useState(false);
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const { summary, refresh, version } = useStore();
  const mobile = useIsMobile();
  const toast = useToast();
  // Before "Start på nytt" the months are history: what's assigned there no longer counts, so it can't be edited.
  const startIso = useStore().summary?.budgetStart ?? null;
  const readOnly = !!startIso && month < startIso.slice(0, 7);
  const startLabel = startIso ? monthLabel(startIso.slice(0, 7)).split(' ')[0].toLowerCase() : '';

  // Every request that brings back the whole budget gets a number; only the newest one may update the screen.
  // Otherwise a slow, older reply (from an earlier field, or a reload after a sync) can land last and make
  // what you just typed in "Fordelt" disappear.
  const seq = useRef(0);
  const apply = useCallback((n: number, b: BudgetMonth) => {
    if (n === seq.current) setBudget(b);
  }, []);
  const load = useCallback(() => {
    const n = ++seq.current;
    return api.get<BudgetMonth>(`/budget/${month}`).then((b) => apply(n, b));
  }, [month, apply]);
  useEffect(() => {
    load();
  }, [load, version]);
  useEffect(() => {
    api.get<Recurring[]>('/recurring').then(setRecurring);
  }, [version]);

  const assign = async (categoryId: number, amount: number) => {
    if (readOnly) {
      toast(`Måneder før ${startLabel} er historikk og kan ikke endres. Fordel i ${startLabel} eller senere.`, { error: true });
      return;
    }
    // Show the new number at once, and keep it there while it saves.
    setBudget((b) => {
      if (!b) return b;
      const old = b.groups.flatMap((g) => g.categories).find((c) => c.id === categoryId);
      if (!old) return b;
      const diff = amount - old.assigned;
      return {
        ...b,
        readyToAssign: b.readyToAssign - diff,
        assigned: b.assigned + diff,
        available: b.available + diff,
        groups: b.groups.map((g) => ({
          ...g,
          categories: g.categories.map((c) => (c.id === categoryId ? { ...c, assigned: amount, available: c.available + diff } : c)),
        })),
      };
    });
    const n = ++seq.current;
    try {
      apply(n, await api.put<BudgetMonth>(`/budget/${month}/${categoryId}`, { amount }));
      refresh();
    } catch (e: any) {
      toast(`Kunne ikke lagre beløpet: ${e.message}. Prøv igjen.`, { error: true });
      load();
    }
  };

  const auto = async (mode: string, label: string) => {
    const before = budget;
    const undo = before && {
      label: 'Angre',
      run: async () => {
        const assigned = Object.fromEntries(before.groups.flatMap((g) => g.categories).map((c) => [c.id, c.assigned]));
        await api.post(`/budget/${month}/restore`, { assigned });
        load();
        refresh();
      },
    };
    const n = ++seq.current;
    let r: { assigned: number; budget: BudgetMonth };
    try {
      r = await api.post<{ assigned: number; budget: BudgetMonth }>(`/budget/${month}/auto`, { mode });
    } catch (e: any) {
      toast(e.message, { error: true });
      return;
    }
    apply(n, r.budget);
    setAutoOpen(false);
    refresh();
    haptic();
    if (mode !== 'reset' && r.assigned === 0) {
      toast(before && before.readyToAssign <= 0 ? 'Ingenting igjen å fordele. Klar til fordeling er tom.' : 'Ingenting mangler, kategoriene er allerede dekket.');
    } else if (mode !== 'reset') toast(`${label}: fordelte ${kr(r.assigned)}`, undo ? { action: undo } : undefined);
    else if (undo) toast('Fordelingen er nullstilt', { action: undo });
  };

  // After «Start på nytt» in a coming month, open the budget on that month.
  const startMonth = summary?.budgetStart?.slice(0, 7) ?? null;
  useEffect(() => {
    if (startMonth && !params.get('month') && currentMonth() < startMonth) setParams({ month: startMonth }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMonth]);

  const all = useMemo(() => budget?.groups.flatMap((g) => g.categories) ?? [], [budget]);
  const current = all.find((c) => c.id === selected) ?? null;

  if (!budget || !summary) return <Skeleton rows={8} />;
  const hasAccounts = summary.accounts.length > 0;
  const visible = (c: CategoryRow) => (showHidden || !c.hidden) && FILTERS.find((f) => f.id === filter)!.test(c);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((c) => !c.hidden && f.test(c)).length])) as Record<Filter, number>;
  const groups = budget.groups
    .filter((g) => showHidden || !g.hidden)
    .map((g) => ({ ...g, shown: g.categories.filter(visible) }))
    .filter((g) => filter === 'all' || g.shown.length > 0);
  const toggleGroup = (id: number) => setCollapsed((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const [monthName, yearName] = monthLabel(month).split(' ');
  const header = (
    <div className="page-head budget-head">
      <div className="month-nav">
        <h1>
          {monthName} <span className="year">{yearName}</span>
        </h1>
        <div className="month-steps">
          <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Forrige måned">
            <Icon name="left" size={18} />
          </button>
          <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Neste måned">
            <Icon name="right" size={18} />
          </button>
        </div>
        {month !== currentMonth() && (
          <button className="btn sm ghost" onClick={() => setMonth(currentMonth())}>
            I dag
          </button>
        )}
      </div>
      {!mobile && (
        <div className="row" style={{ gap: 8 }}>
          <button className={`btn ${budget.readyToAssign > 0 ? 'primary' : ''}`} onClick={() => setAutoOpen(true)}>
            <Icon name="magic" size={16} /> Autofordel
          </button>
        </div>
      )}
    </div>
  );

  const filters = (
    <div className="chips filters" role="tablist" aria-label="Filter">
      {FILTERS.map((f) => (
        <button key={f.id} role="tab" aria-selected={filter === f.id} className={`chip-btn ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
          {f.label}
          {f.id !== 'all' && counts[f.id] > 0 && <span className={`count ${f.id}`}>{counts[f.id]}</span>}
        </button>
      ))}
    </div>
  );

  const detail = current && (
    <CategoryDetail
      key={current.id}
      cat={current}
      month={month}
      all={all}
      rta={budget.readyToAssign}
      onAssign={(a) => assign(current.id, a)}
      readOnly={readOnly}
      onChanged={async () => {
        await load();
        refresh();
      }}
    />
  );

  return (
    <>
      {header}
      {!hasAccounts && <Welcome />}
      {startMonth && month < startMonth && (
        <div className="callout info small" style={{ marginBottom: 12 }}>
          <Icon name="calendar" size={18} />
          <div style={{ flex: 1 }}>
            Budsjettet startet på nytt {`1. ${monthLabel(startMonth).toLowerCase()}`}. Måneder før det er bare historikk.
          </div>
          <button className="btn sm" onClick={() => setMonth(startMonth)}>
            Gå til {monthLabel(startMonth).split(' ')[0].toLowerCase()}
          </button>
        </div>
      )}
      <Payday budget={budget} month={month} onChanged={() => { load(); refresh(); }} />
      {/* Status first: what's left to assign and the month's totals, in one place. */}
      <BudgetHealth budget={budget} month={month} onAuto={() => setAutoOpen(true)} />
      <Attention budget={budget} />
      {/* On a phone the month's wrap-up and tips follow the status; on a PC they sit in the side column. */}
      {mobile && (
        <>
          <WrapUp month={month} startMonth={startMonth} onChanged={() => { load(); refresh(); }} />
          <Tips month={month} onChanged={() => { load(); refresh(); }} />
        </>
      )}

      {mobile ? (
        <>
          {filters}
          <div className="stack" style={{ gap: 12 }}>
            {groups.map((g) => {
              const open = !collapsed.includes(g.id) || filter !== 'all';
              const available = g.shown.reduce((s, c) => s + c.available, 0);
              return (
                <section key={g.id} className="card m-group">
                  <button className="m-group-head" onClick={() => toggleGroup(g.id)} aria-expanded={open}>
                    <Tile color={groupTint(g.name).color} icon={groupTint(g.name).icon} size={26} />
                    <span className="spacer">{g.name}</span>
                    <Icon name={open ? 'down' : 'right'} size={16} />
                    <span className="num small muted">{kr(available)}</span>
                  </button>
                  {open &&
                    g.shown.map((c) => {
                      const sub = subtitle(c, budget.pace);
                      return (
                        <button key={c.id} className="m-cat" onClick={() => setSelected(c.id)} style={{ opacity: c.hidden ? 0.5 : 1 }}>
                          <Tile color={groupTint(g.name).color} letter={c.name} size={30} />
                          <div className="m-cat-main">
                            <span className="m-cat-name">{c.name}</span>
                            {sub && <span className={`m-cat-sub ${sub.tone ?? ''}`}>{sub.text}</span>}
                            <UsageBar c={c} pace={budget.pace} />
                          </div>
                          <Pill c={c} />
                        </button>
                      );
                    })}
                </section>
              );
            })}
            {groups.length === 0 && <div className="empty small">Ingen kategorier her. 🎉</div>}
            <CardBills budget={budget} onCover={(c) => assign(c.id, c.assigned + c.needed)} />
            <Upcoming items={recurring} />
          </div>
          {current && (
            <Modal title={current.name} onClose={() => setSelected(null)}>
              {detail}
            </Modal>
          )}
        </>
      ) : (
        <div className="grid-2">
          <div>
            <div className="ws">
              <div className="ws-head">
                <h2>Kategorier</h2>
                {filters}
                <label className="check small muted ws-hidden">
                  <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Vis skjulte
                </label>
              </div>
              <div className="ws-cols" aria-hidden="true">
                <span>Kategori</span>
                <span>Forbruk</span>
                <span>Fordelt</span>
                <span>Brukt</span>
                <span>Tilgjengelig</span>
              </div>
              {groups.map((g) => {
                const open = !collapsed.includes(g.id) || filter !== 'all';
                const sum = (k: 'assigned' | 'activity' | 'available') => g.shown.reduce((s, c) => s + c[k], 0);
                const tint = groupTint(g.name);
                return (
                  <section key={g.id} className="g-card">
                    <table className="budget-table">
                      <colgroup>
                        <col />
                        <col className="c-use" />
                        <col className="c-assign" />
                        <col className="c-spent" />
                        <col className="c-avail" />
                      </colgroup>
                      <tbody>
                        <GroupRows
                          id={g.id}
                          name={g.name}
                          tint={tint.color}
                          icon={tint.icon}
                          open={open}
                          onToggle={() => toggleGroup(g.id)}
                          totals={{ assigned: sum('assigned'), activity: sum('activity'), available: sum('available') }}
                          count={g.shown.length}
                          onAdded={load}
                        >
                          {open &&
                            g.shown.map((c) => (
                              <CategoryLine
                                key={c.id}
                                c={c}
                                tint={tint.color}
                                pace={budget.pace}
                                selected={selected === c.id}
                                onSelect={() => setSelected(c.id === selected ? null : c.id)}
                                onAssign={(a) => assign(c.id, a)}
                                readOnly={readOnly}
                              />
                            ))}
                        </GroupRows>
                      </tbody>
                    </table>
                  </section>
                );
              })}
              {groups.length === 0 && <div className="card empty small">Ingen kategorier her.</div>}
            </div>
          </div>
          <div className="stack panel">
            {current ? (
              <div className="card card-pad">
                <div className="row" style={{ marginBottom: 6 }}>
                  <h3 style={{ margin: 0, flex: 1 }}>{current.name}</h3>
                  <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Lukk">
                    <Icon name="close" />
                  </button>
                </div>
                {detail}
              </div>
            ) : (
              <>
                <WrapUp month={month} startMonth={startMonth} onChanged={() => { load(); refresh(); }} />
                <Tips month={month} onChanged={() => { load(); refresh(); }} />
                <CardBills budget={budget} onCover={(c) => assign(c.id, c.assigned + c.needed)} />
                <Upcoming items={recurring} />
                <p className="panel-hint">
                  Klikk på en kategori for å fordele, flytte penger eller se siste kjøp. Fordelt tar regnestykker, som <code>1500+300</code>.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {autoOpen && <AutoAssignMenu budget={budget} onPick={auto} onClose={() => setAutoOpen(false)} />}
    </>
  );
}

/**
 * The month at a glance, in rings: the outer ring is how much of what's assigned is spent, the inner ring how far
 * into the month we are. Spending ahead of the calendar shows as the outer ring running ahead of the inner one.
 * Beside it, the one number that needs action (Klar til fordeling) and the month's totals.
 */
function BudgetHealth({ budget, month, onAuto }: { budget: BudgetMonth; month: string; onAuto: () => void }) {
  const rta = budget.readyToAssign;
  const state = rta > 0 ? 'positive' : rta < 0 ? 'negative' : 'zero';
  const spent = -budget.activity;
  const share = budget.assigned > 0 ? Math.max(0, spent / budget.assigned) : 0;
  const pace = budget.pace;
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const day = pace >= 1 ? days : Math.max(1, Math.round(pace * days));
  const ahead = pace > 0 && share > pace + 0.1;
  const figures = [
    { label: 'Inntekt', value: budget.income },
    { label: 'Fordelt', value: budget.assigned },
    { label: 'Brukt', value: spent },
    { label: 'Tilgjengelig', value: budget.available },
  ];
  return (
    <section className={`health card ${state}`} aria-label="Status for måneden">
      <Rings
        size={136}
        stroke={14}
        gap={4}
        label={`${Math.round(share * 100)} % av det som er fordelt er brukt, dag ${day} av ${days}`}
        rings={[
          { value: share, color: ahead ? 'var(--t-orange)' : 'var(--brand)' },
          { value: pace > 0 ? pace : 1, color: 'var(--t-blue)' },
        ]}
      >
        <strong className="num">{Math.round(share * 100)}%</strong>
        <span>brukt</span>
      </Rings>
      <div className="health-main">
        <div className="health-label">Klar til fordeling</div>
        <div className="health-amount">
          <AnimatedMoney value={rta} />
        </div>
        <div className="health-status">
          {rta > 0 && 'Penger uten jobb. Fordel dem til kategoriene.'}
          {rta < 0 && 'Fordelt mer enn dere har. Ta tilbake fra en kategori.'}
          {rta === 0 && 'Hver krone har en jobb.'}
        </div>
        <div className="health-legend">
          <span>
            <i style={{ background: ahead ? 'var(--t-orange)' : 'var(--brand)' }} />
            Brukt av fordelt
          </span>
          <span>
            <i style={{ background: 'var(--t-blue)' }} />
            Dag {day} av {days}
          </span>
        </div>
        <button className={`btn sm ${rta > 0 ? 'primary' : ''} health-auto`} onClick={onAuto}>
          <Icon name="magic" size={15} /> Autofordel
        </button>
      </div>
      <dl className="health-figures">
        {figures.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>
              <AnimatedMoney value={f.value} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** A category's spending as a small ring, with the share beside it. */
function MiniRing({ c, pace, tint }: { c: CategoryRow; pace: number; tint: string }) {
  const u = usage(c, pace);
  if (!u.show) return <span className="mini-ring none" />;
  const over = c.available < 0;
  const color = over ? 'var(--bad)' : u.fast ? 'var(--t-orange)' : tint;
  return (
    <span className={`mini-ring ${over ? 'bad' : u.fast ? 'warn' : ''}`} title={`${Math.round(u.ratio * 100)} % brukt${u.fast ? ', raskere enn kalenderen' : ''}`}>
      <Rings size={22} stroke={4} gap={0} rings={[{ value: over ? 1 : u.ratio, color }]} label={`${Math.round(u.ratio * 100)} % brukt`} />
      <span className="num">{over ? 'Over' : `${Math.round(u.ratio * 100)} %`}</span>
    </span>
  );
}

/** A slim bar: spent of what was there to spend. */
function Meter({ spent, funds, color }: { spent: number; funds: number; color?: string }) {
  if (funds <= 0 && spent <= 0) return <div className="meter meter-none" />;
  const ratio = funds > 0 ? Math.min(1, Math.max(0, spent / funds)) : 1;
  return (
    <div className="meter">
      <div className={`meter-fill ${spent > funds ? 'bad' : ''}`} style={{ width: `${ratio * 100}%`, background: spent > funds ? undefined : color }} />
    </div>
  );
}

function GroupRows({
  id,
  name,
  open,
  onToggle,
  totals,
  count,
  tint,
  icon,
  onAdded,
  children,
}: {
  id: number;
  name: string;
  open: boolean;
  onToggle: () => void;
  totals: { assigned: number; activity: number; available: number };
  count: number;
  tint: string;
  icon: string;
  onAdded: () => void;
  children: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const { refresh } = useStore();
  return (
    <>
      <tr className={`group ${open ? 'open' : ''}`} onClick={onToggle}>
        <td>
          <span className="group-name">
            <Tile color={tint} icon={icon} size={26} />
            {name}
            <span className="group-count">{count}</span>
            <Icon name={open ? 'down' : 'right'} size={14} />
            <button
              className="icon-btn add-cat"
              onClick={(e) => {
                e.stopPropagation();
                setAdding(true);
              }}
              aria-label={`Legg til kategori i ${name}`}
              title="Legg til kategori"
            >
              <Icon name="plus" size={14} />
            </button>
          </span>
        </td>
        <td className="col-use">
          <Meter spent={-totals.activity} funds={totals.available - totals.activity} color={tint} />
        </td>
        <td className="num">{kr(totals.assigned)}</td>
        <td className="num">{totals.activity ? kr(totals.activity) : '–'}</td>
        <td className={`num ${totals.available < 0 ? 'bad-text' : ''}`}>{kr(totals.available)}</td>
      </tr>
      {adding && (
        <tr>
          <td colSpan={5}>
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newName.trim()) return;
                await api.post('/categories', { name: newName, group_id: id });
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
      {children}
    </>
  );
}

function CategoryLine({
  c,
  tint,
  pace,
  selected,
  onSelect,
  onAssign,
  readOnly,
}: {
  c: CategoryRow;
  tint: string;
  pace: number;
  selected: boolean;
  onSelect: () => void;
  onAssign: (amount: number) => void;
  readOnly?: boolean;
}) {
  const sub = subtitle(c, pace);
  return (
    <tr className={`cat ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <td>
        <div className="cat-cell" style={{ opacity: c.hidden ? 0.5 : 1 }}>
          <Tile color={tint} letter={c.name} size={24} />
          <div style={{ minWidth: 0 }}>
            <div className="cat-name">{c.name}</div>
            {sub && <div className={`cat-sub ${sub.tone ?? ''}`}>{sub.text}</div>}
          </div>
        </div>
      </td>
      <td className="col-use">
        <MiniRing c={c} pace={pace} tint={tint} />
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <MoneyInput
          className="assign-input"
          value={c.assigned}
          onCommit={(v) => (haptic(), onAssign(v))}
          ariaLabel={`Fordelt til ${c.name}`}
          disabled={readOnly}
        />
      </td>
      <td className="num muted">{c.activity ? kr(c.activity) : '–'}</td>
      <td>
        <Pill c={c} />
      </td>
    </tr>
  );
}
