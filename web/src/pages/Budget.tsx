/**
 * Budsjett: where you manage the money. Give every krone a job, see what's left in each category, fix overspending.
 * Desktop: a dense table with a detail panel on the right. Phone: tappable cards with a bottom sheet.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type BudgetMonth, type CategoryRow, type Recurring } from '../api';
import { dayLabel, kr, monthLabel } from '../format';
import { IncomeEditor, PayCard, newIncome, type IncomeDraft } from './income';
import { useStore } from '../store';
import { usePrefs } from '../prefs';
import { Rings, Tile, groupTint } from '../components/apple';
import { useIsMobile, useIsWide, useStoredState } from '../hooks';
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
  const [incomeDraft, setIncomeDraft] = useState<IncomeDraft | null>(null);
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const { summary, refresh, version } = useStore();
  const mobile = useIsMobile();
  // On a wide screen the month's wrap-up and tips sit in the side column instead of across the whole page.
  const wide = useIsWide() && !mobile;
  // Which columns the budget table shows. Saved per device; until chosen, wide screens also show last month and the
  // 3-month average.
  const [savedCols, setSavedCols] = useStoredState<ColKey[] | null>('budget.columns', null);
  const colList: ColKey[] = savedCols ?? (wide ? ['spent', 'last', 'avg', 'usage'] : ['spent', 'usage']);
  const cols: Cols = { spent: colList.includes('spent'), last: colList.includes('last'), avg: colList.includes('avg'), usage: colList.includes('usage') };
  const toggleCol = (k: ColKey) => setSavedCols(colList.includes(k) ? colList.filter((x) => x !== k) : [...colList, k]);
  const { prefs } = usePrefs();
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

  const auto = async (mode: string, label: string, withExpected = false) => {
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
      r = await api.post<{ assigned: number; budget: BudgetMonth }>(`/budget/${month}/auto`, { mode, withExpected });
    } catch (e: any) {
      toast(e.message, { error: true });
      return;
    }
    apply(n, r.budget);
    setAutoOpen(false);
    refresh();
    haptic();
    if (mode !== 'reset' && r.assigned === 0) {
      toast(before && before.readyToAssign + (withExpected ? (before.expected?.pending ?? 0) : 0) <= 0 ? 'Ingenting igjen å fordele. Klar til fordeling er tom.' : 'Ingenting mangler, kategoriene er allerede dekket.');
    } else if (mode !== 'reset')
      toast(`${label}: fordelte ${kr(r.assigned)}${withExpected && r.budget.readyToAssign < 0 ? `, ${kr(-r.budget.readyToAssign)} av det fra lønnen som kommer` : ''}`, undo ? { action: undo } : undefined);
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

  const header = (
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
      {!mobile && (
        <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
          <ColumnPicker cols={cols} onToggle={toggleCol} />
          <label className="check small muted">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Vis skjulte
          </label>
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
      {!wide && <WrapUp month={month} startMonth={startMonth} onChanged={() => { load(); refresh(); }} />}
      <Payday budget={budget} month={month} onChanged={() => { load(); refresh(); }} />
      {!wide && <Tips month={month} onChanged={() => { load(); refresh(); }} />}
      <Attention budget={budget} />
      <Hero budget={budget} onAuto={() => setAutoOpen(true)} />
      <Stats budget={budget} />

      {mobile ? (
        <>
          {budget.expected && (budget.expected.items.length > 0 || budget.readyToAssign < 0) && (
            <div style={{ marginBottom: 12 }}>
              <PayCard budget={budget} onEdit={setIncomeDraft} onAdd={() => setIncomeDraft(newIncome())} />
            </div>
          )}
          {filters}
          <div className="stack" style={{ gap: 12 }}>
            {groups.map((g) => {
              const open = !collapsed.includes(g.id) || filter !== 'all';
              const available = g.shown.reduce((s, c) => s + c.available, 0);
              return (
                <section key={g.id} className="card m-group">
                  <button className="m-group-head" onClick={() => toggleGroup(g.id)} aria-expanded={open}>
                    <Icon name={open ? 'down' : 'right'} size={16} />
                    {prefs.catIcons && <Tile color={groupTint(g.name).color} icon={groupTint(g.name).icon} size={22} />}
                    <span className="spacer">{g.name}</span>
                    <span className="num small muted">{kr(available)}</span>
                  </button>
                  {open &&
                    g.shown.map((c) => {
                      const sub = subtitle(c, budget.pace);
                      return (
                        <button key={c.id} className="m-cat" onClick={() => setSelected(c.id)} style={{ opacity: c.hidden ? 0.5 : 1 }}>
                          {prefs.catIcons && <Tile color={groupTint(g.name).color} letter={c.name} size={30} />}
                          <div className="m-cat-main">
                            <span className="m-cat-name">{c.name}</span>
                            {sub && <span className={`m-cat-sub ${sub.tone ?? ''}`}>{sub.text}</span>}
                            {!prefs.catRing && <UsageBar c={c} pace={budget.pace} />}
                          </div>
                          {prefs.catRing && <MiniRing c={c} pace={budget.pace} tint={groupTint(g.name).color} />}
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
            {filters}
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="budget-table">
                <thead>
                  <tr>
                    <th>Kategori</th>
                    <th>Fordelt</th>
                    {cols.spent && <th>Brukt</th>}
                    {cols.last && <th title="Det kategorien brukte forrige måned">Forrige mnd</th>}
                    {cols.avg && <th title="Snittforbruk de tre siste månedene">Snitt 3 mnd</th>}
                    <th>Tilgjengelig</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const open = !collapsed.includes(g.id) || filter !== 'all';
                    const sum = (k: 'assigned' | 'activity' | 'available') => g.shown.reduce((s, c) => s + c[k], 0);
                    return (
                      <GroupRows
                        key={g.id}
                        id={g.id}
                        name={g.name}
                        tint={prefs.catIcons ? groupTint(g.name) : null}
                        open={open}
                        onToggle={() => toggleGroup(g.id)}
                        cols={cols}
                        totals={{
                          assigned: sum('assigned'),
                          activity: sum('activity'),
                          available: sum('available'),
                          last: g.shown.reduce((s, c) => s + c.lastMonthActivity, 0),
                          avg: g.shown.reduce((s, c) => s + c.avgActivity, 0),
                        }}
                        onAdded={load}
                      >
                        {open &&
                          g.shown.map((c) => (
                            <CategoryLine
                              key={c.id}
                              c={c}
                              tint={groupTint(g.name).color}
                              icons={prefs.catIcons}
                              ring={prefs.catRing}
                              cols={cols}
                              pace={budget.pace}
                              selected={selected === c.id}
                              onSelect={() => setSelected(c.id === selected ? null : c.id)}
                              onAssign={(a) => assign(c.id, a)}
                              readOnly={readOnly}
                            />
                          ))}
                      </GroupRows>
                    );
                  })}
                </tbody>
              </table>
              {groups.length === 0 && <div className="empty small">Ingen kategorier her. 🎉</div>}
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
                <div className="card card-pad tip">
                  <span aria-hidden="true">💡</span>
                  <div className="small">
                    <strong>Tips:</strong> klikk på en kategori for å fordele med ett klikk, flytte penger eller se siste kjøp. Skriv regnestykker
                    rett i Fordelt, som <code>1500+300</code>.
                  </div>
                </div>
                {wide && <WrapUp month={month} startMonth={startMonth} onChanged={() => { load(); refresh(); }} />}
                {wide && <Tips month={month} onChanged={() => { load(); refresh(); }} />}
                <PayCard budget={budget} onEdit={setIncomeDraft} onAdd={() => setIncomeDraft(newIncome())} />
                <CardBills budget={budget} onCover={(c) => assign(c.id, c.assigned + c.needed)} />
                <Upcoming items={recurring} />
              </>
            )}
          </div>
        </div>
      )}

      {autoOpen && <AutoAssignMenu budget={budget} onPick={auto} onClose={() => setAutoOpen(false)} />}
      {incomeDraft && (
        <IncomeEditor
          draft={incomeDraft}
          onClose={() => setIncomeDraft(null)}
          onSaved={() => {
            setIncomeDraft(null);
            load();
          }}
        />
      )}
    </>
  );
}

/** The one number that matters most: money that still needs a job. */
function Hero({ budget, onAuto }: { budget: BudgetMonth; onAuto: () => void }) {
  const { prefs } = usePrefs();
  const actual = budget.readyToAssign;
  // Expected pay still to come: assigning ahead of it isn't "more than you have", only ahead of time.
  const pending = budget.expected?.pending ?? 0;
  const next = budget.expected?.next ?? null;
  const planned = actual < 0 && pending > 0 && actual + pending >= 0;
  const rta = planned ? actual + pending : actual;
  const state = planned ? 'planned' : rta > 0 ? 'positive' : rta < 0 ? 'negative' : 'zero';
  const spent = -budget.activity;
  const share = budget.assigned > 0 ? Math.max(0, spent / budget.assigned) : 0;
  const pace = budget.pace > 0 ? budget.pace : 1;
  return (
    <div className={`hero ${state}`}>
      {prefs.budgetRings && (
        <Rings
          size={92}
          stroke={10}
          gap={3}
          label={`${Math.round(share * 100)} % av det som er fordelt er brukt, ${Math.round(pace * 100)} % av måneden er gått`}
          rings={[
            { value: share, color: '#ffffff', track: 'rgb(255 255 255 / 0.22)' },
            { value: pace, color: 'rgb(255 255 255 / 0.62)', track: 'rgb(255 255 255 / 0.14)' },
          ]}
        >
          <strong className="num">{Math.round(share * 100)}%</strong>
          <span>brukt</span>
        </Rings>
      )}
      <div className="hero-main">
        <div className="hero-label">
          {planned
            ? 'Klar til fordeling etter lønn'
            : rta > 0
              ? 'Klar til fordeling'
              : rta < 0
                ? 'Fordelt mer enn dere har'
                : 'Hver krone har en jobb'}
        </div>
        <div className="hero-amount">
          {rta === 0 ? (
            <span className="done-check" aria-hidden="true">
              <Icon name="check" size={28} />
            </span>
          ) : null}
          <AnimatedMoney value={rta} />
        </div>
        <div className="hero-sub small">
          {planned && next && `Fordelt på forhånd: ${kr(actual)} nå, og ${kr(pending)} ventes (${next.name} ${dayLabel(next.date)}).`}
          {!planned && pending > 0 && next && rta >= 0 && `${kr(pending)} ventes i tillegg (${next.name} ${dayLabel(next.date)}). `}
          {!planned && pending > 0 && rta < 0 && `Selv med ${kr(pending)} som ventes, er det fordelt ${kr(-(rta + pending))} for mye. `}
          {!planned && rta > 0 && 'Gi pengene en jobb: trykk på en kategori, eller la autofordeling gjøre det.'}
          {!planned && rta < 0 && pending === 0 && 'Ta tilbake penger fra en kategori til dette blir 0.'}
          {!planned && rta === 0 && pending === 0 && 'Bra jobbet! Neste lønn dukker opp her.'}
          {prefs.budgetRings && (
            <span className="hero-rings-key">
              {' '}
              Ytre ring: brukt av fordelt. Indre: dag {Math.max(1, Math.round(pace * daysIn(budget.month)))} av {daysIn(budget.month)}.
            </span>
          )}
        </div>
      </div>
      {rta > 0 && !planned && (
        <button className="btn hero-btn" onClick={onAuto}>
          <Icon name="magic" size={16} /> Autofordel
        </button>
      )}
      {(rta <= 0 || planned) && (
        <button className="btn ghost hero-btn" onClick={onAuto}>
          <Icon name="magic" size={16} /> Autofordel
        </button>
      )}
    </div>
  );
}

const daysIn = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();

/** A category's spending as a small ring, with the share beside it. */
function MiniRing({ c, pace, tint }: { c: CategoryRow; pace: number; tint: string }) {
  const u = usage(c, pace);
  if (!u.show) return <span className="mini-ring none" aria-hidden="true" />;
  const over = c.available < 0;
  const color = over ? 'var(--bad)' : u.fast ? 'var(--warn)' : tint;
  return (
    <span className={`mini-ring ${over ? 'bad' : u.fast ? 'warn' : ''}`} title={`${Math.round(u.ratio * 100)} % brukt${u.fast ? ', raskere enn kalenderen' : ''}`}>
      <Rings size={22} stroke={4} gap={0} rings={[{ value: over ? 1 : u.ratio, color }]} label={`${Math.round(u.ratio * 100)} % brukt`} />
      <span className="num">{over ? 'Over' : `${Math.round(u.ratio * 100)} %`}</span>
    </span>
  );
}

function Stats({ budget }: { budget: BudgetMonth }) {
  const items = [
    { label: 'Inntekt', value: budget.income },
    { label: 'Fordelt', value: budget.assigned },
    { label: 'Brukt', value: -budget.activity },
    { label: 'Tilgjengelig', value: budget.available },
  ];
  return (
    <div className="stats">
      {items.map((i) => (
        <div key={i.label} className="stat-mini">
          <span>{i.label}</span>
          <AnimatedMoney value={i.value} />
        </div>
      ))}
    </div>
  );
}

type ColKey = 'spent' | 'last' | 'avg' | 'usage';
type Cols = Record<ColKey, boolean>;
const COLUMNS: Array<{ key: ColKey; label: string; help: string }> = [
  { key: 'spent', label: 'Brukt', help: 'Det som er brukt denne måneden' },
  { key: 'last', label: 'Forrige mnd', help: 'Det kategorien brukte forrige måned' },
  { key: 'avg', label: 'Snitt 3 mnd', help: 'Snittforbruket de tre siste månedene' },
  { key: 'usage', label: 'Forbruk', help: 'Ring eller strek for hvor mye som er brukt' },
];

/** "Kolonner": choose which columns the budget table shows. Fordelt and Tilgjengelig are always there. */
function ColumnPicker({ cols, onToggle }: { cols: Cols; onToggle: (k: ColKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const shown = COLUMNS.filter((c) => cols[c.key]).length;
  return (
    <div className="col-picker" ref={ref}>
      <button className="btn sm ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true">
        <Icon name="filter" size={15} /> Kolonner
        <span className="faint">{shown + 2}</span>
      </button>
      {open && (
        <div className="col-menu" role="menu">
          <div className="small muted" style={{ padding: '2px 4px 6px' }}>
            Fordelt og Tilgjengelig vises alltid.
          </div>
          {COLUMNS.map((c) => (
            <label key={c.key} className="col-option">
              <input type="checkbox" checked={cols[c.key]} onChange={() => onToggle(c.key)} />
              <span>
                <strong>{c.label}</strong>
                <span className="small muted">{c.help}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupRows({
  id,
  name,
  open,
  onToggle,
  totals,
  cols,
  tint,
  onAdded,
  children,
}: {
  id: number;
  name: string;
  open: boolean;
  onToggle: () => void;
  totals: { assigned: number; activity: number; available: number; last: number; avg: number };
  cols: Cols;
  tint: { color: string; icon: string } | null;
  onAdded: () => void;
  children: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const { refresh } = useStore();
  return (
    <>
      <tr className="group" onClick={onToggle}>
        <td>
          <span className="row" style={{ gap: 6 }}>
            <Icon name={open ? 'down' : 'right'} size={14} />
            {tint && <Tile color={tint.color} icon={tint.icon} size={20} />}
            {name}
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
        <td className="num">{kr(totals.assigned)}</td>
        {cols.spent && <td className="num">{kr(totals.activity)}</td>}
        {cols.last && <td className="num">{kr(totals.last)}</td>}
        {cols.avg && <td className="num">{kr(totals.avg)}</td>}
        <td className="num">{kr(totals.available)}</td>
      </tr>
      {adding && (
        <tr>
          <td colSpan={3 + Number(cols.spent) + Number(cols.last) + Number(cols.avg)}>
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
  icons,
  ring,
  cols,
  pace,
  selected,
  onSelect,
  onAssign,
  readOnly,
}: {
  c: CategoryRow;
  tint: string;
  icons: boolean;
  ring: boolean;
  cols: Cols;
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
          {icons && <Tile color={tint} letter={c.name} size={26} />}
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="cat-name">{c.name}</div>
            {sub && <div className={`cat-sub ${sub.tone ?? ''}`}>{sub.text}</div>}
            {cols.usage && !ring && <UsageBar c={c} pace={pace} />}
          </div>
          {cols.usage && ring && <MiniRing c={c} pace={pace} tint={tint} />}
        </div>
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
      {cols.spent && <td className="num muted">{c.activity ? kr(c.activity) : '–'}</td>}
      {cols.last && <td className="num faint">{c.lastMonthActivity ? kr(c.lastMonthActivity) : '–'}</td>}
      {cols.avg && (
        <td
          className={`num faint ${c.avgActivity && c.activity < c.avgActivity ? 'over-avg' : ''}`}
          title={c.avgActivity && c.activity < c.avgActivity ? 'Brukt mer enn snittet allerede denne måneden' : undefined}
        >
          {c.avgActivity ? kr(c.avgActivity) : '–'}
        </td>
      )}
      <td>
        <Pill c={c} />
      </td>
    </tr>
  );
}
