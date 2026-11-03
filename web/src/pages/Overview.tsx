/**
 * Oversikt: where the money actually went. Pick a month (or 3/12 months) and see totals against the period before,
 * how spending builds through the month, which categories and shops took the most, and the biggest purchases.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { dayLabel, kr, monthLabel, shortMonth } from '../format';
import { useStore } from '../store';
import { useIsMobile, useStoredState } from '../hooks';
import { AnimatedMoney, Icon, Money, Skeleton } from '../components/ui';
import { Arranged, normalize, type Layout } from './overviewLayout';
import { Tile, groupTint } from '../components/apple';
import { CashflowCard, DonutCard, RecurringCard, VsUsualCard } from './overviewExtra';
import { CashflowChart, ChartCard, NetWorthChart, PaceChart, SimpleTable, type WorthRow } from '../components/charts';
import { addMonths, currentMonth, daysInMonth, todayISO } from '../../../shared/months';

interface OverviewData {
  from: string;
  to: string;
  income: number;
  spending: number;
  prevIncome: number;
  prevSpending: number;
  pendingIncome: number;
  historyBefore: string | null;
  fixedSpending: number;
  prevFixedSpending: number;
  groups: Array<{
    id: number | null;
    name: string;
    spent: number;
    prevSpent: number;
    fixed: boolean;
    categories: Array<{ id: number | null; name: string; spent: number; prevSpent: number; count: number; fixed: boolean }>;
  }>;
  accounts: Array<{ id: number; name: string; spent: number; count: number }>;
  weekdays: Array<{ day: number; avg: number; total: number }>;
  calendar: Array<{ date: string; spent: number }>;
  stats: { purchases: number; days: number; noSpendDays: number; avgPerDay: number; biggestDay: { date: string; spent: number } | null };
  budget: { assigned: number; spent: number; rows: Array<{ id: number; name: string; assigned: number; spent: number }> } | null;
  forecast: { projected: number; everydayRest: number; billsLeft: number; billsLeftCount: number } | null;
  payees: Array<{ payee: string; spent: number; count: number; category: string | null }>;
  largest: Array<{ id: number; date: string; payee: string; amount: number; category: string | null; account: string }>;
  daily: Array<{ day: number; cum: number | null; prevCum: number | null }>;
  months: Array<{ month: string; income: number; spending: number }>;
}

const SPANS = [
  { span: 1, label: 'Måned', prev: 'forrige måned' },
  { span: 3, label: '3 mnd', prev: 'forrige 3 mnd' },
  { span: 12, label: '12 mnd', prev: 'året før' },
];

function periodLabel(month: string, span: number) {
  if (span === 1) return monthLabel(month);
  const start = addMonths(month, -(span - 1));
  return `${shortMonth(start)} ${start.slice(0, 4) !== month.slice(0, 4) ? start.slice(0, 4) + ' ' : ''}– ${shortMonth(month)} ${month.slice(0, 4)}`;
}

/** Change against the previous period, phrased plainly ("12 % mer enn forrige måned"). */
function Delta({ now, prev, prevLabel, goodWhenUp }: { now: number; prev: number; prevLabel: string; goodWhenUp: boolean }) {
  if (!prev) return <span className="delta faint">Ingen data for {prevLabel}</span>;
  const pct = Math.round(((now - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return <span className="delta faint">Likt som {prevLabel}</span>;
  const up = pct > 0;
  const good = up === goodWhenUp;
  return (
    <span className={`delta ${good ? 'good' : 'bad'}`}>
      {up ? '▲' : '▼'} {Math.abs(pct)} % {up ? 'mer' : 'mindre'} enn {prevLabel}
    </span>
  );
}

export default function OverviewPage() {
  const [params, setParams] = useSearchParams();
  const [span, setSpan] = useStoredState<number>('overview.span', 1);
  const month = params.get('month') ?? currentMonth();
  const setMonth = (m: string) => setParams(m === currentMonth() ? {} : { month: m });
  const [data, setData] = useState<OverviewData | null>(null);
  const [worth, setWorth] = useState<WorthRow[]>([]);
  const { version } = useStore();
  const mobile = useIsMobile();

  useEffect(() => {
    setData(null);
    api.get<OverviewData>(`/overview?month=${month}&span=${span}`).then(setData);
  }, [month, span, version]);
  useEffect(() => {
    api.get<WorthRow[]>('/reports/networth?months=12').then(setWorth);
  }, [version]);

  const [savedLayout, saveLayout] = useStoredState<Layout | null>('overview.layout', null);
  const layout = useMemo(() => normalize(savedLayout), [savedLayout]);
  const setLayout = (l: Layout) => saveLayout(l);
  const [editing, setEditing] = useState(false);

  const prevLabel = SPANS.find((s) => s.span === span)!.prev;
  const insights = useMemo(
    () => (data ? buildInsights(data, prevLabel, span === 1 && month === currentMonth() && Number(todayISO().slice(8, 10)) < 25) : []),
    [data, prevLabel, span, month],
  );

  const head = (
    <div className="page-head">
      <div className="month-nav">
        <button className="icon-btn" onClick={() => setMonth(addMonths(month, -span))} aria-label="Forrige periode">
          <Icon name="left" />
        </button>
        <h1>{periodLabel(month, span)}</h1>
        <button className="icon-btn" onClick={() => setMonth(addMonths(month, span))} aria-label="Neste periode" disabled={month >= currentMonth()}>
          <Icon name="right" />
        </button>
      </div>
      <div className="row ov-head-tools" style={{ gap: 8 }}>
        {editing ? (
          <>
            <button className="btn ghost sm" onClick={() => saveLayout(null)}>
              Tilbakestill
            </button>
            <button className="btn primary sm" onClick={() => setEditing(false)}>
              Ferdig
            </button>
          </>
        ) : (
          <button className="btn sm" onClick={() => setEditing(true)} aria-label="Tilpass Oversikt">
            <Icon name="edit" size={15} /> Tilpass
          </button>
        )}
      <div className="seg" role="tablist" aria-label="Periode">
        {SPANS.map((s) => (
          <button key={s.span} role="tab" aria-selected={span === s.span} className={span === s.span ? 'on' : ''} onClick={() => setSpan(s.span)}>
            {s.label}
          </button>
        ))}
      </div>
      </div>
    </div>
  );

  if (!data) {
    return (
      <>
        {head}
        <Skeleton rows={8} />
      </>
    );
  }

  const saved = data.income - data.spending;
  const rate = data.income > 0 ? Math.round((saved / data.income) * 100) : null;
  // The month we're in isn't over: compare with the same day last month, not with all of it.
  const running = span === 1 && month === currentMonth();
  const dayNow = Number(todayISO().slice(8, 10));
  const prevSameDay = running ? data.daily[dayNow - 1]?.prevCum ?? null : null;
  const empty = data.spending === 0 && data.income === 0;

  const history = data.historyBefore && (
    <div className="callout warn small">
      <Icon name="calendar" size={18} />
      <div>
        Historikk fra før budsjettet startet på nytt {Number(data.historyBefore.slice(8, 10))}.{' '}
        {monthLabel(data.historyBefore.slice(0, 7)).toLowerCase()}. Overføringer mellom egne kontoer og kort uten fullstendig
        historikk (som TF Bank) kan gjøre noen tall skjeve.
      </div>
    </div>
  );
  // Before a fresh start nothing is reviewed, so fixing categories happens in Transaksjoner instead.
  const fixLink = data.historyBefore && month < data.historyBefore.slice(0, 7) ? `/transactions?month=${month}` : '/review';
  const pending = (
    <>
      {history}
      {data.pendingIncome > 0 && (
        <Link to={fixLink} className="callout info small" style={{ textDecoration: 'none', color: 'inherit' }}>
          <Icon name="inbox" size={18} />
          <div>
            <strong>{kr(data.pendingIncome)}</strong> i innbetalinger mangler kategori og er ikke regnet som inntekt ennå.{' '}
            <span style={{ color: 'var(--brand-text)', fontWeight: 600 }}>Gi dem kategori →</span>
          </div>
        </Link>
      )}
    </>
  );

  const tiles = (
    <div className="ov-tiles">
      <div className="card ov-tile">
        <span className="ov-label">Brukt</span>
        <AnimatedMoney value={data.spending} className="ov-value" />
        {running && prevSameDay !== null ? (
          <Delta now={data.spending} prev={prevSameDay} prevLabel={`samme dag ${prevLabel}`} goodWhenUp={false} />
        ) : (
          <Delta now={data.spending} prev={data.prevSpending} prevLabel={prevLabel} goodWhenUp={false} />
        )}
      </div>
      <div className="card ov-tile">
        <span className="ov-label">Inntekt</span>
        <AnimatedMoney value={data.income} className="ov-value" />
        {running && data.income === 0 ? (
          <span className="delta faint">Ingen inntekt ennå denne måneden</span>
        ) : (
          <Delta now={data.income} prev={data.prevIncome} prevLabel={prevLabel} goodWhenUp />
        )}
      </div>
      {data.income === 0 && (data.pendingIncome > 0 || running) ? (
        // Salary not reviewed yet: "spent more than you earned" would be a false alarm.
        <div className="card ov-tile">
          <span className="ov-label">Til overs</span>
          <span className="ov-value faint">–</span>
          <span className="delta faint">{data.pendingIncome > 0 ? 'Gå gjennom innbetalingene først' : 'Venter på inntekt'}</span>
        </div>
      ) : (
        <div className={`card ov-tile ${saved >= 0 ? 'good' : 'bad'}`}>
          <span className="ov-label">{saved >= 0 ? 'Til overs' : 'Brukt mer enn inntekt'}</span>
          <AnimatedMoney value={Math.abs(saved)} className="ov-value" />
          <span className="delta faint">{rate !== null ? `${Math.max(rate, 0)} % av inntekten spart` : 'Ingen inntekt registrert'}</span>
        </div>
      )}
      {data.forecast ? (
        <div className="card ov-tile">
          <span className="ov-label">Ligger an til</span>
          <AnimatedMoney value={data.forecast.projected} className="ov-value" />
          <span className="delta faint">
            {data.prevSpending > 0
              ? `${data.forecast.projected > data.prevSpending ? 'Mer' : 'Mindre'} enn forrige måned (${kr(data.prevSpending)})`
              : 'Brukt ved månedsslutt, med dagens tempo'}
          </span>
        </div>
      ) : (
        <div className="card ov-tile">
          <span className="ov-label">Hverdag per dag</span>
          <AnimatedMoney value={data.stats.avgPerDay} className="ov-value" />
          <span className="delta faint">
            {data.stats.noSpendDays} av {data.stats.days} dager uten hverdagsforbruk
          </span>
        </div>
      )}
    </div>
  );

  const story = <Story data={data} month={month} span={span} prevLabel={prevLabel} />;

  const pace =
    span === 1 && data.daily.length > 0 ? (
      <ChartCard
        title="Forbruk gjennom måneden"
        sub="Er dere på sporet? Linjen viser hvor mye som er brukt så langt, mot samme dag forrige måned."
        legend={[
          { label: 'Denne måneden', color: 'var(--series-1)' },
          { label: 'Forrige måned', color: 'var(--faint)', dashed: true },
        ]}
        table={
          <SimpleTable
            head={['Dag', 'Denne måneden', 'Forrige måned']}
            rows={data.daily.map((d) => [`${d.day}.`, d.cum === null ? '–' : kr(d.cum), d.prevCum === null ? '–' : kr(d.prevCum)])}
          />
        }
      >
        <PaceChart rows={data.daily} />
      </ChartCard>
    ) : null;

  const trend =
    span > 1 ? (
      <ChartCard
        title="Inntekt og forbruk per måned"
        legend={[
          { label: 'Inntekt', color: 'var(--series-1)' },
          { label: 'Forbruk', color: 'var(--series-2)' },
        ]}
        table={
          <SimpleTable
            head={['Måned', 'Inntekt', 'Forbruk', 'Spart']}
            rows={data.months.map((r) => [monthLabel(r.month), kr(r.income), kr(r.spending), kr(r.income - r.spending)])}
          />
        }
      >
        <CashflowChart rows={data.months} />
      </ChartCard>
    ) : null;

  const categories = <Categories data={data} month={month} span={span} prevLabel={prevLabel} />;
  const payees = <Payees data={data} />;
  const largest = <Largest data={data} />;
  const budget = data.budget && <BudgetVsActual budget={data.budget} month={month} />;
  const days = span === 1 ? <Calendar data={data} month={month} /> : <Weekdays data={data} />;
  const accounts = <Accounts data={data} />;
  const insightCards = insights.length > 0 && (
    <div className="insights">
      {insights.map((i, n) => (
        <div key={n} className={`card insight ${i.tone}`}>
          <span className="insight-icon">{i.icon}</span>
          <div className="small">{i.text}</div>
        </div>
      ))}
    </div>
  );
  const worthCard = worth.some((w) => w.assets || w.debts) ? (
    <ChartCard
      title="Formue"
      sub="Alle kontoer, også boliglån og sparing"
      table={<SimpleTable head={['Måned', 'Eiendeler', 'Gjeld', 'Formue']} rows={worth.map((r) => [monthLabel(r.month), kr(r.assets), kr(-r.debts), kr(r.netWorth)])} />}
    >
      <NetWorthChart rows={worth} />
    </ChartCard>
  ) : null;

  return (
    <>
      {head}
      {empty ? (
        <div className="card empty ov-empty">
          <div className="emoji">📊</div>
          <div>
            {month === currentMonth() && span === 1
              ? `${monthLabel(month).split(' ')[0]} har så vidt begynt, så det er ingenting å vise ennå.`
              : `Ingen inntekter eller utgifter i ${periodLabel(month, span).toLowerCase()}.`}
          </div>
          <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
            <button className="btn primary sm" onClick={() => setMonth(addMonths(month, -span))}>
              Se {span === 1 ? monthLabel(addMonths(month, -1)).split(' ')[0].toLowerCase() : 'perioden før'}
            </button>
            {span === 1 && (
              <button className="btn sm" onClick={() => setSpan(3)}>
                Siste 3 måneder
              </button>
            )}
            {month !== currentMonth() && (
              <button className="btn ghost sm" onClick={() => setMonth(currentMonth())}>
                Til i dag
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: mobile ? 14 : 16 }}>
          {pending}
          {editing && (
            <div className="callout info small">
              <Icon name="edit" size={18} />
              <div>
                Flytt kortene med pilene, velg plassering og fjern det du ikke trenger. Fjernede kort kan legges til igjen
                nederst. Oppsettet lagres på denne enheten.
              </div>
            </div>
          )}
          <Arranged
            layout={layout}
            mobile={mobile}
            editing={editing}
            onChange={setLayout}
            nodes={{
              tiles,
              story,
              insights: insightCards || null,
              budget,
              trend: pace ?? trend,
              categories,
              days,
              payees,
              accounts,
              largest,
              worth: worthCard,
              cashflow: <CashflowCard />,
              vsUsual: span === 1 ? <VsUsualCard month={month} fixedIds={new Set(data.groups.flatMap((g) => g.categories.filter((c) => c.fixed && c.id !== null).map((c) => c.id as number)))} pace={month === currentMonth() ? Number(todayISO().slice(8, 10)) / daysInMonth(month) : 1} /> : null,
              recurring: <RecurringCard />,
              donut: <DonutCard groups={data.groups} />,
            }}
          />
        </div>
      )}
    </>
  );
}

function buildInsights(d: OverviewData, prevLabel: string, partial = false) {
  const out: Array<{ icon: string; text: React.ReactNode; tone: string }> = [];
  // Early in a running month, "Dagligvarer er ned 100 %" only means the month has just started.
  if (partial) {
    if (d.stats.days >= 7 && d.stats.noSpendDays >= 3)
      out.push({ icon: '🗓️', tone: 'good', text: <><strong>{d.stats.noSpendDays} dager</strong> uten hverdagsforbruk så langt. Hver slik dag er penger spart.</> });
    const uncategorizedNow = d.groups.find((g) => g.id === null);
    if (uncategorizedNow && uncategorizedNow.spent > 0)
      out.push({ icon: '🏷️', tone: 'warn', text: <>{kr(uncategorizedNow.spent)} er uten kategori. Gå gjennom dem for et riktigere bilde.</> });
    return out;
  }
  const cats = d.groups.flatMap((g) => g.categories).filter((c) => c.id !== null);
  const changes = cats
    .filter((c) => c.prevSpent > 0 && Math.abs(c.spent - c.prevSpent) >= 50_000)
    .map((c) => ({ ...c, diff: c.spent - c.prevSpent, pct: Math.round(((c.spent - c.prevSpent) / c.prevSpent) * 100) }));
  const up = changes.filter((c) => c.pct >= 20).sort((a, b) => b.diff - a.diff)[0];
  const down = changes.filter((c) => c.pct <= -20).sort((a, b) => a.diff - b.diff)[0];
  if (up)
    out.push({ icon: '📈', tone: 'warn', text: <><strong>{up.name}</strong> har økt med {kr(up.diff)} ({up.pct} %) mot {prevLabel}.</> });
  if (down)
    out.push({ icon: '🎉', tone: 'good', text: <><strong>{down.name}</strong> er ned {kr(-down.diff)} ({Math.abs(down.pct)} %) mot {prevLabel}. Godt jobbet!</> });
  const everyday = d.spending - d.fixedSpending;
  const prevEveryday = d.prevSpending - d.prevFixedSpending;
  if (prevEveryday > 0 && Math.abs(everyday - prevEveryday) >= 100_000) {
    const more = everyday > prevEveryday;
    out.push({
      icon: more ? '🛒' : '🌱',
      tone: more ? 'warn' : 'good',
      text: <>Hverdagsforbruket er {kr(Math.abs(everyday - prevEveryday))} {more ? 'høyere' : 'lavere'} enn {prevLabel}.</>,
    });
  }
  if (d.stats.days >= 7 && d.stats.noSpendDays >= 3)
    out.push({ icon: '🗓️', tone: 'good', text: <><strong>{d.stats.noSpendDays} dager</strong> uten hverdagsforbruk. Hver slik dag er penger spart.</> });
  const uncategorized = d.groups.find((g) => g.id === null);
  if (uncategorized && uncategorized.spent > 0)
    out.push({ icon: '🏷️', tone: 'warn', text: <>{kr(uncategorized.spent)} er uten kategori. Gå gjennom dem for et riktigere bilde.</> });
  return out.slice(0, 3);
}

/**
 * Hvor pengene gikk: groups and their categories, biggest first. Each bar is this period in the group's colour, with
 * the previous period as a pale bar behind it, so "more or less than last time" reads at a glance. Groups and
 * categories with nothing spent are tucked away behind a link.
 */
function Categories({ data, month, span, prevLabel }: { data: OverviewData; month: string; span: number; prevLabel: string }) {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  // A running month compared with a whole one would always look "lower", so then the difference isn't coloured.
  const running = span === 1 && month === currentMonth();
  const groups = [...data.groups].sort((a, b) => b.spent - a.spent || b.prevSpent - a.prevSpent);
  const active = groups.filter((g) => g.spent > 0);
  const quiet = groups.filter((g) => g.spent <= 0);
  const [closed, setClosed] = useState<string[]>(() => (mobile ? active.slice(1).map((g) => String(g.id)) : []));
  const [showQuiet, setShowQuiet] = useState(false);
  const [showAll, setShowAll] = useState<string[]>([]);
  const shownGroups = showQuiet ? groups : active;
  const max = Math.max(1, ...shownGroups.map((g) => Math.max(g.spent, g.prevSpent)));
  const total = Math.max(1, data.spending);
  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const prevName = prevLabel.replace(/^samme dag /, '');

  const diff = (now: number, prev: number) => {
    if (!prev) return <span className="wm-prev">Ingenting {prevName}</span>;
    const d = now - prev;
    if (running) return <span className="wm-prev">{prevName[0].toUpperCase() + prevName.slice(1)}: {kr(prev)}</span>;
    if (Math.abs(d) < 100) return <span className="wm-prev">Som {prevName}</span>;
    return (
      <span className={`wm-diff ${d > 0 ? 'up' : 'down'}`}>
        {d > 0 ? '▲' : '▼'} {kr(Math.abs(d))}
      </span>
    );
  };

  return (
    <ChartCard
      title="Hvor pengene gikk"
      sub={<>Størst først. Den lyse streken bak er {prevName}. Trykk på en kategori for å se kjøpene.</>}
      table={
        <SimpleTable
          head={['Kategori', 'Brukt', prevLabel[0].toUpperCase() + prevLabel.slice(1)]}
          rows={data.groups.flatMap((g) => [[g.name, kr(g.spent), kr(g.prevSpent)], ...g.categories.map((c) => [`  ${c.name}`, kr(c.spent), kr(c.prevSpent)])])}
        />
      }
    >
      <SplitBar fixed={data.fixedSpending} total={data.spending} />
      {active.length === 0 && <div className="small muted" style={{ padding: '12px 0' }}>Ingenting brukt i perioden ennå.</div>}
      <div className="wm">
        {shownGroups.map((g) => {
          const key = String(g.id);
          const isOpen = !closed.includes(key);
          const tint = g.id === null ? { color: 'var(--faint)', icon: 'list' } : groupTint(g.name);
          const cats = [...g.categories].sort((a, b) => b.spent - a.spent || b.prevSpent - a.prevSpent);
          const spentCats = cats.filter((c) => c.spent > 0);
          const restCats = cats.filter((c) => c.spent <= 0);
          const visibleCats = showAll.includes(key) ? cats : spentCats;
          const cmax = Math.max(1, ...visibleCats.map((c) => Math.max(c.spent, c.prevSpent)));
          const share = Math.round((Math.max(0, g.spent) / total) * 100);
          return (
            <section key={key} className={`wm-group ${isOpen ? 'open' : ''}`} style={{ '--wm': tint.color } as React.CSSProperties}>
              <button className="wm-row head" onClick={() => setClosed((c) => toggle(c, key))} aria-expanded={isOpen}>
                <span className="wm-name">
                  <Tile color={tint.color} icon={tint.icon} size={26} />
                  <span className="wm-title">
                    <strong>{g.name}</strong>
                    <small>{g.spent > 0 ? `${share} % av forbruket` : 'Ingenting brukt'}</small>
                  </span>
                </span>
                <Bar now={g.spent} prev={g.prevSpent} max={max} />
                <span className="wm-amount">
                  <strong className="num">{kr(g.spent)}</strong>
                  {diff(g.spent, g.prevSpent)}
                </span>
                <Icon name={isOpen ? 'up' : 'down'} size={15} className="wm-chev" />
              </button>
              {isOpen && (
                <div className="wm-cats">
                  {visibleCats.map((c) => (
                    <button
                      key={String(c.id)}
                      className="wm-row"
                      onClick={() => navigate(`/transactions?category=${c.id ?? 'none'}${span === 1 ? `&month=${month}` : ''}`)}
                    >
                      <span className="wm-name">
                        <span className="wm-title">
                          <span>{c.name}</span>
                          <small>{c.count ? `${c.count} kjøp` : 'Ingen kjøp'}</small>
                        </span>
                      </span>
                      <Bar now={c.spent} prev={c.prevSpent} max={cmax} light />
                      <span className="wm-amount">
                        <span className="num">{kr(c.spent)}</span>
                        {diff(c.spent, c.prevSpent)}
                      </span>
                      <span className="wm-chev" />
                    </button>
                  ))}
                  {restCats.length > 0 && !showAll.includes(key) && (
                    <button className="link-btn wm-more" onClick={() => setShowAll((s) => [...s, key])}>
                      Vis {restCats.length} uten kjøp
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {quiet.length > 0 && (
        <button className="link-btn wm-more" onClick={() => setShowQuiet((v) => !v)}>
          {showQuiet ? 'Skjul grupper uten forbruk' : `Vis ${quiet.length} ${quiet.length === 1 ? 'gruppe' : 'grupper'} uten forbruk`}
        </button>
      )}
    </ChartCard>
  );
}

/** This period as a solid bar in the group's colour, the previous one as a pale bar behind it. */
function Bar({ now, prev, max, light }: { now: number; prev: number; max: number; light?: boolean }) {
  return (
    <span className={`wm-track ${light ? 'light' : ''}`} aria-hidden="true">
      {prev > 0 && <span className="wm-bar prev" style={{ width: `${(prev / max) * 100}%` }} />}
      {now > 0 && <span className="wm-bar now" style={{ width: `${(Math.max(0, now) / max) * 100}%` }} />}
    </span>
  );
}

function Payees({ data }: { data: OverviewData }) {
  const navigate = useNavigate();
  if (!data.payees.length) return null;
  const max = data.payees[0].spent;
  return (
    <div className="card card-pad">
      <h3 style={{ marginBottom: 0 }}>Hvor dere handlet mest</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>Butikker og steder, uten faste regninger</div>
      <div className="payees">
        {data.payees.map((p, i) => (
          <button key={p.payee} className="payee-row" onClick={() => navigate(`/transactions?q=${encodeURIComponent(p.payee)}`)}>
            <span className="rank">{i + 1}</span>
            <span className="grow">
              <span className="row" style={{ gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
                <span className="ellipsis" style={{ fontWeight: 550 }}>{p.payee}</span>
                <span className="faint small">{p.count}×</span>
              </span>
              <span className="payee-bar" style={{ width: `${(p.spent / max) * 100}%` }} />
            </span>
            <Money value={p.spent} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Largest({ data }: { data: OverviewData }) {
  if (!data.largest.length) return null;
  return (
    <div className="card card-pad">
      <h3 style={{ marginBottom: 0 }}>Største kjøp</h3>
      <div className="small muted" style={{ marginBottom: 6 }}>Uten faste regninger</div>
      <div className="list compact">
        {data.largest.map((t) => (
          <div key={`${t.id}-${t.amount}`} className="list-item">
            <div className="grow">
              <div className="ellipsis" style={{ fontWeight: 550 }}>{t.payee}</div>
              <div className="small faint">
                {dayLabel(t.date)} · {t.category ?? 'Uten kategori'} · {t.account}
              </div>
            </div>
            <Money value={t.amount} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One plain sentence that sums the period up, so the numbers below have a story. */
function Story({ data, month, span, prevLabel }: { data: OverviewData; month: string; span: number; prevLabel: string }) {
  const everyday = data.spending - data.fixedSpending;
  // In a running month, compare with the same day last month.
  const running = span === 1 && month === currentMonth();
  const base = running ? data.daily[Number(todayISO().slice(8, 10)) - 1]?.prevCum ?? 0 : data.prevSpending;
  const pct = base ? Math.round(((data.spending - base) / base) * 100) : null;
  const period = span === 1 ? `I ${monthLabel(month).split(' ')[0].toLowerCase()}` : `De siste ${span} månedene`;
  const top = data.groups.flatMap((g) => g.categories).filter((c) => c.id !== null && !c.fixed)[0];
  return (
    <p className="ov-story">
      {period} {span === 1 && month === currentMonth() ? 'har dere brukt' : 'brukte dere'} <strong>{kr(data.spending)}</strong>
      {data.fixedSpending > 0 && (
        <>
          : {kr(data.fixedSpending)} på faste utgifter og {kr(everyday)} til hverdags
        </>
      )}
      .{' '}
      {pct !== null && (
        <>
          Det er {pct === 0 ? 'det samme som' : `${Math.abs(pct)} % ${pct > 0 ? 'mer' : 'mindre'} enn`} {running ? `samme dag ${prevLabel}` : prevLabel}.{' '}
        </>
      )}
      {top && top.spent > 0 && (
        <>
          Mest av hverdagspengene gikk til <strong>{top.name.toLowerCase()}</strong> ({kr(top.spent)}).
        </>
      )}
      {data.forecast && (
        <>
          {' '}
          Med dagens tempo ender måneden på rundt <strong>{kr(Math.round(data.forecast.projected / 10000) * 10000)}</strong>
          {data.forecast.billsLeftCount > 0 && <>, med {data.forecast.billsLeftCount} regninger igjen ({kr(data.forecast.billsLeft)})</>}.
        </>
      )}
    </p>
  );
}

/** Fixed costs against everyday spending: one bar, two parts, labelled. */
function SplitBar({ fixed, total }: { fixed: number; total: number }) {
  if (total <= 0 || fixed <= 0) return null;
  const everyday = Math.max(0, total - fixed);
  const f = Math.round((fixed / total) * 100);
  return (
    <div className="split">
      <div className="split-bar" role="img" aria-label={`Faste utgifter ${f} %, hverdag ${100 - f} %`}>
        <span style={{ flexBasis: `${f}%`, background: 'var(--series-1)' }} title={`Faste utgifter: ${kr(fixed)}`} />
        <span style={{ flexBasis: `${100 - f}%`, background: 'var(--series-2)' }} title={`Hverdag: ${kr(everyday)}`} />
      </div>
      <div className="split-legend">
        <span>
          <span className="swatch" style={{ background: 'var(--series-1)' }} /> Faste utgifter <strong>{kr(fixed)}</strong>{' '}
          <span className="faint">{f} %</span>
        </span>
        <span>
          <span className="swatch" style={{ background: 'var(--series-2)' }} /> Hverdag <strong>{kr(everyday)}</strong>{' '}
          <span className="faint">{100 - f} %</span>
        </span>
      </div>
    </div>
  );
}

/** Budsjett mot faktisk: what you set aside for each category against what you spent. Overspent first. */
function BudgetVsActual({ budget, month }: { budget: NonNullable<OverviewData['budget']>; month: string }) {
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const rows = [...budget.rows].sort((a, b) => {
    const over = (r: typeof a) => r.spent - r.assigned;
    if ((over(a) > 0) !== (over(b) > 0)) return over(a) > 0 ? -1 : 1;
    if (over(a) > 0) return over(b) - over(a);
    return b.spent / Math.max(1, b.assigned) - a.spent / Math.max(1, a.assigned);
  });
  const shown = all ? rows : rows.slice(0, 7);
  const overCount = rows.filter((r) => r.spent > r.assigned).length;
  return (
    <div className="card card-pad">
      <h3 style={{ marginBottom: 0 }}>Budsjett mot faktisk</h3>
      <div className="small muted" style={{ marginBottom: 12 }}>
        Brukt {kr(budget.spent)} av {kr(budget.assigned)} fordelt
        {overCount > 0 ? ` · ${overCount} ${overCount === 1 ? 'kategori' : 'kategorier'} over` : ' · alt innenfor'}
      </div>
      <div className="bva">
        {shown.map((r) => {
          const over = r.spent - r.assigned;
          const scale = Math.max(r.assigned, r.spent, 1);
          return (
            <button key={r.id} className="bva-row" onClick={() => navigate(`/transactions?category=${r.id}&month=${month}`)}>
              <span className="bva-top">
                <span className="ellipsis" style={{ fontWeight: 550 }}>
                  {r.name}
                </span>
                <span className={`small num ${over > 0 ? 'bad-text' : 'muted'}`}>
                  {over > 0 ? `${kr(over)} over` : r.assigned > 0 ? `${kr(-over)} igjen` : 'Ikke fordelt'}
                </span>
              </span>
              <span className="bva-track" title={`${kr(r.spent)} brukt av ${kr(r.assigned)}`}>
                <span className="bva-fill" style={{ width: `${(Math.min(r.spent, r.assigned) / scale) * 100}%` }} />
                {over > 0 && <span className="bva-over" style={{ width: `${(over / scale) * 100}%` }} />}
                {r.assigned > 0 && r.spent < r.assigned && <span className="bva-end" style={{ left: `${(r.assigned / scale) * 100}%` }} />}
              </span>
              <span className="small faint num">
                {kr(r.spent)} av {kr(r.assigned)}
              </span>
            </button>
          );
        })}
      </div>
      {rows.length > 7 && (
        <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setAll(!all)}>
          {all ? 'Vis færre' : `Vis alle ${rows.length}`}
        </button>
      )}
    </div>
  );
}

const WEEKDAYS = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];

/** "1 234" for under 10 000 kr, "12k" above: short enough to fit in a calendar cell. */
function compactKr(ore: number) {
  const k = Math.round(ore / 100);
  if (k < 10000) return k.toLocaleString('nb-NO');
  return `${Math.round(k / 1000)}k`;
}

/** ISO week number, as Norwegian calendars count them. */
function isoWeek(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/**
 * Dag for dag: everyday spending per day (bills left out, so payday doesn't drown everything), with the amount in
 * each day, a total per week, and the month's key figures above. Darker means more, by quartile of the days with
 * spending, so one big day doesn't wash out the rest.
 */
function Calendar({ data, month }: { data: OverviewData; month: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const days = data.calendar;
  const all = Array.from({ length: Number(`${month}-01` <= todayISO() ? daysInMonthOf(month) : 0) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  if (!all.length) return null;
  const byDate = new Map(days.map((d) => [d.date, d.spent]));
  const spentDays = days.filter((d) => d.spent > 0).map((d) => d.spent).sort((a, b) => a - b);
  const q = (p: number) => spentDays[Math.min(spentDays.length - 1, Math.floor(p * spentDays.length))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
  const offset = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  const today = todayISO();
  // Weeks of seven slots (empty before the 1st and after the last day).
  const slots: Array<string | null> = [...Array(offset).fill(null), ...all];
  while (slots.length % 7) slots.push(null);
  const weeks = Array.from({ length: slots.length / 7 }, (_, i) => slots.slice(i * 7, i * 7 + 7));
  const weekTotal = (w: Array<string | null>) => w.reduce((s, d) => s + (d ? byDate.get(d) ?? 0 : 0), 0);
  const maxWeek = Math.max(1, ...weeks.map(weekTotal));
  const sel = picked ? { date: picked, spent: byDate.get(picked) ?? 0 } : null;
  const big = data.stats.biggestDay;

  return (
    <ChartCard
      title="Dag for dag"
      sub="Hverdagsforbruk per dag, uten faste regninger. Mørkere betyr mer."
      table={<SimpleTable head={['Dag', 'Brukt']} rows={days.map((d) => [dayLabel(d.date), kr(d.spent)])} />}
    >
      <div className="kpis">
        <div>
          <span>Snitt per dag</span>
          <strong>{compactKr(data.stats.avgPerDay)} kr</strong>
          <small>{data.stats.days} dager så langt</small>
        </div>
        <div>
          <span>Uten forbruk</span>
          <strong className="good-text">
            {data.stats.noSpendDays} {data.stats.noSpendDays === 1 ? 'dag' : 'dager'}
          </strong>
          <small>av {data.stats.days}</small>
        </div>
        <div>
          <span>Dyreste dag</span>
          <strong>{big ? `${compactKr(big.spent)} kr` : '–'}</strong>
          <small>{big ? dayLabel(big.date) : 'ingen kjøp ennå'}</small>
        </div>
      </div>

      <div className="cal2" role="grid" aria-label="Forbruk per dag">
        <div className="cal2-row head" role="row">
          {WEEKDAYS.map((w) => (
            <span key={w} role="columnheader">
              {w}
            </span>
          ))}
          <span role="columnheader" className="cal2-week-h">
            Uke
          </span>
        </div>
        {weeks.map((w, i) => {
          const total = weekTotal(w);
          const first = w.find(Boolean)!;
          return (
            <div key={i} className="cal2-row" role="row">
              {w.map((date, j) => {
                if (!date) return <span key={`e${j}`} className="cal2-day empty" />;
                const future = date > today;
                const v = byDate.get(date) ?? 0;
                const lvl = future ? 'x' : level(v);
                return (
                  <button
                    key={date}
                    role="gridcell"
                    className={`cal2-day l${lvl} ${date === today ? 'today' : ''} ${picked === date ? 'on' : ''}`}
                    disabled={future}
                    onClick={() => setPicked(picked === date ? null : date)}
                    title={future ? '' : `${dayLabel(date)}: ${v ? kr(v) : 'ingen hverdagsforbruk'}`}
                  >
                    <span className="cal2-num">{Number(date.slice(8))}</span>
                    {!future && (v > 0 ? <span className="cal2-amt num">{compactKr(v)}</span> : <span className="cal2-zero">✓</span>)}
                  </button>
                );
              })}
              <span className="cal2-week" title={`Uke ${isoWeek(first)}: ${kr(total)}`}>
                <small>Uke {isoWeek(first)}</small>
                <strong className="num">{total ? compactKr(total) : '–'}</strong>
                <span className="cal2-week-bar">
                  <span style={{ width: `${(total / maxWeek) * 100}%` }} />
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="cal-foot">
        <span className="small muted">
          {sel ? (
            <>
              <strong>{dayLabel(sel.date)}</strong>: {sel.spent ? kr(sel.spent) : 'ingen hverdagsforbruk'} ·{' '}
              <Link to={`/transactions?month=${month}`}>se kjøpene</Link>
            </>
          ) : (
            <>Trykk på en dag for beløpet. ✓ = ingen hverdagsforbruk.</>
          )}
        </span>
        <span className="cal-scale small faint" aria-hidden>
          Mindre
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={`cal-swatch l${l}`} />
          ))}
          Mer
        </span>
      </div>
    </ChartCard>
  );
}

function daysInMonthOf(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Ukedager: which days of the week the everyday money goes. */
function Weekdays({ data }: { data: OverviewData }) {
  const max = Math.max(1, ...data.weekdays.map((w) => w.avg));
  const top = data.weekdays.reduce((a, b) => (b.avg > a.avg ? b : a), data.weekdays[0]);
  if (!top || top.avg === 0) return null;
  return (
    <ChartCard
      title="Ukedager"
      sub={<>Hverdagsforbruk i snitt per dag, uten faste regninger. Mest på {WEEKDAYS[top.day]}dager.</>}
      table={<SimpleTable head={['Dag', 'Snitt', 'Totalt']} rows={data.weekdays.map((w) => [WEEKDAYS[w.day], kr(w.avg), kr(w.total)])} />}
    >
      <div className="wk">
        {data.weekdays.map((w) => (
          <div key={w.day} className="wk-col" title={`${WEEKDAYS[w.day]}: ${kr(w.avg)} i snitt`}>
            <span className="wk-val small num">{w.day === top.day ? kr(w.avg) : ''}</span>
            <span className="wk-bar" style={{ height: `${(w.avg / max) * 100}%` }} />
            <span className="wk-label small muted">{WEEKDAYS[w.day]}</span>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

/** Per konto og kort: which card or account the money left from. */
function Accounts({ data }: { data: OverviewData }) {
  const navigate = useNavigate();
  if (data.accounts.length < 2) return null;
  const total = Math.max(1, data.accounts.reduce((s, a) => s + a.spent, 0));
  const max = data.accounts[0].spent;
  return (
    <div className="card card-pad">
      <h3 style={{ marginBottom: 0 }}>Per konto og kort</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>Hvor pengene gikk ut fra</div>
      <div className="payees">
        {data.accounts.map((a) => (
          <button key={a.id} className="payee-row" onClick={() => navigate(`/transactions?account=${a.id}`)}>
            <span className="grow">
              <span className="row" style={{ gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
                <span className="ellipsis" style={{ fontWeight: 550 }}>
                  {a.name}
                </span>
                <span className="faint small">
                  {a.count} kjøp · {Math.round((a.spent / total) * 100)} %
                </span>
              </span>
              <span className="payee-bar" style={{ width: `${(a.spent / max) * 100}%` }} />
            </span>
            <Money value={a.spent} />
          </button>
        ))}
      </div>
    </div>
  );
}
