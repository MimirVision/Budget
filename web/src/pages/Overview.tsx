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
import { addMonths, currentMonth } from '../../../shared/months';

interface OverviewData {
  from: string;
  to: string;
  income: number;
  spending: number;
  prevIncome: number;
  prevSpending: number;
  pendingIncome: number;
  groups: Array<{
    id: number | null;
    name: string;
    spent: number;
    prevSpent: number;
    categories: Array<{ id: number | null; name: string; spent: number; prevSpent: number; count: number }>;
  }>;
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

/** The period is before "Start på nytt": say so, instead of looking like nothing happened. */
function BeforeStart({ start, onGo }: { start: string; onGo: (month: string) => void }) {
  const startMonth = start.slice(0, 7);
  const date = `${Number(start.slice(8, 10))}. ${monthLabel(startMonth).toLowerCase()}`;
  const future = startMonth > currentMonth();
  return (
    <div className="stack" style={{ gap: 12, alignItems: 'center' }}>
      <div>
        Budsjettet ditt starter på nytt {date}, så Oversikten teller bare det som skjer fra da.
        {future ? ' De første tallene dukker opp her når måneden begynner.' : ''}
      </div>
      <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {!future && (
          <button className="btn primary sm" onClick={() => onGo(startMonth)}>
            Gå til {monthLabel(startMonth).split(' ')[0].toLowerCase()}
          </button>
        )}
        <Link className="btn sm" to="/transactions">
          Se transaksjonene
        </Link>
      </div>
      <div className="faint small">Du kan endre eller angre startdatoen under Innstillinger → Budsjett.</div>
    </div>
  );
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
  const { version, summary } = useStore();
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

  const pending = data.pendingIncome > 0 && (
    <Link to="/review" className="callout info small" style={{ textDecoration: 'none', color: 'inherit' }}>
      <Icon name="inbox" size={18} />
      <div>
        <strong>{kr(data.pendingIncome)}</strong> i innbetalinger mangler kategori og er ikke regnet som inntekt ennå.{' '}
        <span style={{ color: 'var(--brand-text)', fontWeight: 600 }}>Gå gjennom dem →</span>
      </div>
    </Link>
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
    </div>
  );

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
          {summary?.budgetStart && `${month}-31` < summary.budgetStart ? (
            <BeforeStart start={summary.budgetStart} onGo={(m) => setMonth(m)} />
          ) : (
            <>Ingen inntekter eller utgifter i {periodLabel(month, span).toLowerCase()} ennå.</>
          )}
        </div>
      ) : mobile ? (
        <div className="stack" style={{ gap: 14 }}>
          {pending}
          {tiles}
          {insightCards}
          {pace}
          {trend}
          {categories}
          {payees}
          {largest}
          {worthCard}
        </div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {pending}
          {tiles}
          <div className="ov-grid">
            <div className="stack" style={{ gap: 16 }}>
              {pace}
              {trend}
              {categories}
            </div>
            <div className="stack" style={{ gap: 16 }}>
              {insightCards}
              {payees}
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
  const top = d.payees[0];
  if (top) out.push({ icon: '🏪', tone: 'info', text: <>Mest penger gikk til <strong>{top.payee}</strong>: {kr(top.spent)} fordelt på {top.count} kjøp.</> });
  const big = d.largest[0];
  if (big) out.push({ icon: '💸', tone: 'info', text: <>Største enkeltkjøp: <strong>{big.payee}</strong>, {kr(-big.amount)} den {dayLabel(big.date)}</> });
  const uncategorized = d.groups.find((g) => g.id === null);
  if (uncategorized && uncategorized.spent > 0)
    out.push({ icon: '🏷️', tone: 'warn', text: <>{kr(uncategorized.spent)} er uten kategori. Gå gjennom dem for et riktigere bilde.</> });
  return out.slice(0, 4);
}

function Categories({ data, month, span, prevLabel }: { data: OverviewData; month: string; span: number; prevLabel: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const max = Math.max(1, ...data.groups.map((g) => Math.max(g.spent, g.prevSpent)));
  const total = Math.max(1, data.spending);
  const open1 = (key: string) => setOpen(open === key ? null : key);
  return (
    <ChartCard
      title="Hvor pengene gikk"
      sub={<>Trykk på en gruppe for kategoriene. Den mørke streken viser {prevLabel}.</>}
      table={
        <SimpleTable
          head={['Kategori', 'Brukt', prevLabel[0].toUpperCase() + prevLabel.slice(1)]}
          rows={data.groups.flatMap((g) => [[g.name, kr(g.spent), kr(g.prevSpent)], ...g.categories.map((c) => [`  ${c.name}`, kr(c.spent), kr(c.prevSpent)])])}
        />
      }
    >
      <div className="breakdown">
        {data.groups.map((g) => {
          const key = String(g.id);
          const isOpen = open === key;
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
      <h3>Hvor dere handlet mest</h3>
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
      <h3>Største kjøp</h3>
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
