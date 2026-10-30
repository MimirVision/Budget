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
import { CashflowChart, ChartCard, NetWorthChart, PaceChart, SimpleTable, type WorthRow } from '../components/charts';
import { addMonths, currentMonth, todayISO } from '../../../shared/months';

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

  const prevLabel = SPANS.find((s) => s.span === span)!.prev;
  const insights = useMemo(() => (data ? buildInsights(data, prevLabel) : []), [data, prevLabel]);

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
      <div className="seg" role="tablist" aria-label="Periode">
        {SPANS.map((s) => (
          <button key={s.span} role="tab" aria-selected={span === s.span} className={span === s.span ? 'on' : ''} onClick={() => setSpan(s.span)}>
            {s.label}
          </button>
        ))}
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
        <Delta now={data.spending} prev={data.prevSpending} prevLabel={prevLabel} goodWhenUp={false} />
      </div>
      <div className="card ov-tile">
        <span className="ov-label">Inntekt</span>
        <AnimatedMoney value={data.income} className="ov-value" />
        <Delta now={data.income} prev={data.prevIncome} prevLabel={prevLabel} goodWhenUp />
      </div>
      {data.income === 0 && data.pendingIncome > 0 ? (
        // Salary not reviewed yet: "spent more than you earned" would be a false alarm.
        <div className="card ov-tile">
          <span className="ov-label">Til overs</span>
          <span className="ov-value faint">–</span>
          <span className="delta faint">Gå gjennom innbetalingene først</span>
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
        <div className="card empty">
          <div className="emoji">📊</div>
          Ingen inntekter eller utgifter i {periodLabel(month, span).toLowerCase()} ennå.
        </div>
      ) : mobile ? (
        <div className="stack" style={{ gap: 14 }}>
          {pending}
          {tiles}
          {story}
          {insightCards}
          {budget}
          {pace}
          {trend}
          {categories}
          {days}
          {payees}
          {accounts}
          {largest}
          {worthCard}
        </div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {pending}
          {tiles}
          {story}
          <div className="ov-grid">
            <div className="stack" style={{ gap: 16 }}>
              {pace}
              {trend}
              {categories}
              {days}
            </div>
            <div className="stack" style={{ gap: 16 }}>
              {budget}
              {insightCards}
              {payees}
              {accounts}
              {largest}
            </div>
          </div>
          {worthCard}
        </div>
      )}
    </>
  );
}

function buildInsights(d: OverviewData, prevLabel: string) {
  const out: Array<{ icon: string; text: React.ReactNode; tone: string }> = [];
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

function Categories({ data, month, span, prevLabel }: { data: OverviewData; month: string; span: number; prevLabel: string }) {
  const navigate = useNavigate();
  // Groups start open, so the categories are visible without a tap; tap a group to fold it away.
  // On the phone they start folded to keep the page short; empty groups always do.
  const mobile = useIsMobile();
  const [closed, setClosed] = useState<string[]>(() =>
    data.groups.filter((g) => mobile || g.spent <= 0).map((g) => String(g.id)),
  );
  const max = Math.max(1, ...data.groups.map((g) => Math.max(g.spent, g.prevSpent)));
  const total = Math.max(1, data.spending);
  const open1 = (key: string) => setClosed((c) => (c.includes(key) ? c.filter((k) => k !== key) : [...c, key]));
  return (
    <ChartCard
      title="Hvor pengene gikk"
      sub={<>Trykk på en gruppe for å folde den, og på en kategori for kjøpene. Den mørke streken viser {prevLabel}.</>}
      table={
        <SimpleTable
          head={['Kategori', 'Brukt', prevLabel[0].toUpperCase() + prevLabel.slice(1)]}
          rows={data.groups.flatMap((g) => [[g.name, kr(g.spent), kr(g.prevSpent)], ...g.categories.map((c) => [`  ${c.name}`, kr(c.spent), kr(c.prevSpent)])])}
        />
      }
    >
      <SplitBar fixed={data.fixedSpending} total={data.spending} />
      <div className="breakdown">
        {data.groups.map((g) => {
          const key = String(g.id);
          const isOpen = !closed.includes(key);
          const cmax = Math.max(1, ...g.categories.map((c) => Math.max(c.spent, c.prevSpent)));
          return (
            <div key={key} className={`bd-group ${isOpen ? 'open' : ''}`}>
              <button className="bd-row" onClick={() => open1(key)} aria-expanded={isOpen}>
                <span className="bd-name">
                  <Icon name={isOpen ? 'down' : 'right'} size={14} />
                  {g.name}
                </span>
                <span className="bd-track">
                  <span className="bd-fill" style={{ width: `${(Math.max(0, g.spent) / max) * 100}%` }} />
                  {g.prevSpent > 0 && <span className="bd-prev" style={{ left: `${(g.prevSpent / max) * 100}%` }} />}
                </span>
                <span className="bd-amount num">
                  {kr(g.spent)}
                  <small>{Math.round((Math.max(0, g.spent) / total) * 100)} %</small>
                </span>
              </button>
              {isOpen &&
                g.categories.map((c) => (
                  <button
                    key={String(c.id)}
                    className="bd-row sub"
                    onClick={() => navigate(`/transactions?category=${c.id ?? 'none'}${span === 1 ? `&month=${month}` : ''}`)}
                  >
                    <span className="bd-name">{c.name}</span>
                    <span className="bd-track">
                      <span className="bd-fill light" style={{ width: `${(Math.max(0, c.spent) / cmax) * 100}%` }} />
                      {c.prevSpent > 0 && <span className="bd-prev" style={{ left: `${(c.prevSpent / cmax) * 100}%` }} />}
                    </span>
                    <span className="bd-amount num">
                      {kr(c.spent)}
                      <small>{c.count} kjøp</small>
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </ChartCard>
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
  const pct = data.prevSpending ? Math.round(((data.spending - data.prevSpending) / data.prevSpending) * 100) : null;
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
          Det er {pct === 0 ? 'det samme som' : `${Math.abs(pct)} % ${pct > 0 ? 'mer' : 'mindre'} enn`} {prevLabel}.{' '}
        </>
      )}
      {top && (
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

/** Kalender: everyday spending per day, darker = more. Bills are left out so payday doesn't drown everything. */
function Calendar({ data, month }: { data: OverviewData; month: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const days = data.calendar;
  const all = Array.from({ length: Number(`${month}-01` <= todayISO() ? daysInMonthOf(month) : 0) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  if (!all.length) return null;
  const byDate = new Map(days.map((d) => [d.date, d.spent]));
  const spentDays = days.filter((d) => d.spent > 0).map((d) => d.spent).sort((a, b) => a - b);
  // Steps by quartile of the days with spending, so one big day doesn't wash the rest out.
  const q = (p: number) => spentDays[Math.min(spentDays.length - 1, Math.floor(p * spentDays.length))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
  const offset = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  const today = todayISO();
  const h = hover ? { date: hover, spent: byDate.get(hover) ?? 0 } : null;
  return (
    <ChartCard
      title="Dag for dag"
      sub="Hverdagsforbruk per dag, uten faste regninger. Mørkere betyr mer."
      table={<SimpleTable head={['Dag', 'Brukt']} rows={days.map((d) => [dayLabel(d.date), kr(d.spent)])} />}
    >
      <div className="cal">
        {WEEKDAYS.map((w) => (
          <span key={w} className="cal-head">
            {w}
          </span>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`pad-${i}`} />
        ))}
        {all.map((date) => {
          const future = date > today;
          const v = byDate.get(date) ?? 0;
          return (
            <span
              key={date}
              className={`cal-day l${future ? 'x' : level(v)} ${hover === date ? 'on' : ''}`}
              onMouseEnter={() => !future && setHover(date)}
              onMouseLeave={() => setHover(null)}
              onClick={() => !future && setHover(hover === date ? null : date)}
              title={future ? '' : `${dayLabel(date)}: ${v ? kr(v) : 'ingen hverdagsforbruk'}`}
            >
              {Number(date.slice(8))}
            </span>
          );
        })}
      </div>
      <div className="cal-foot">
        <span className="small muted">
          {h ? (
            <>
              <strong>{dayLabel(h.date)}</strong>: {h.spent ? kr(h.spent) : 'ingen hverdagsforbruk 🎉'}
            </>
          ) : (
            <>
              <strong>{data.stats.noSpendDays}</strong> dager uten forbruk
              {data.stats.biggestDay && (
                <>
                  {' '}
                  · dyreste dag {dayLabel(data.stats.biggestDay.date)} ({kr(data.stats.biggestDay.spent)})
                </>
              )}
            </>
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
