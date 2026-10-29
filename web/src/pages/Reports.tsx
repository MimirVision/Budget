import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { kr, monthLabel, shortMonth } from '../format';
import { Icon, Money } from '../components/ui';
import { addMonths, currentMonth } from '../../../shared/months';

interface SpendRow {
  id: number;
  name: string;
  group_name: string;
  spent: number;
  usual: number;
}
interface FlowRow {
  month: string;
  income: number;
  spending: number;
}
interface WorthRow {
  month: string;
  assets: number;
  debts: number;
  netWorth: number;
}

const compact = new Intl.NumberFormat('nb-NO', { notation: 'compact', maximumFractionDigits: 1 });
const axisKr = (ore: number) => compact.format(ore / 100);

/** "Nice" axis maximum and ticks, so gridlines land on round numbers. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

export default function ReportsPage() {
  const [month, setMonth] = useState(currentMonth());
  const [spending, setSpending] = useState<SpendRow[]>([]);
  const [flow, setFlow] = useState<FlowRow[]>([]);
  const [worth, setWorth] = useState<WorthRow[]>([]);

  useEffect(() => {
    api.get<SpendRow[]>(`/reports/spending?month=${month}`).then(setSpending);
  }, [month]);
  useEffect(() => {
    api.get<FlowRow[]>('/reports/cashflow?months=12').then(setFlow);
    api.get<WorthRow[]>('/reports/networth?months=12').then(setWorth);
  }, []);

  const last3 = flow.slice(-4, -1);
  const avgIncome = last3.length ? last3.reduce((s, r) => s + r.income, 0) / last3.length : 0;
  const avgSpend = last3.length ? last3.reduce((s, r) => s + r.spending, 0) / last3.length : 0;
  const savingsRate = avgIncome > 0 ? (avgIncome - avgSpend) / avgIncome : null;
  const nw = worth[worth.length - 1];
  // Compare with the first month that has any data, not an empty month before you started.
  const nwYearAgo = worth.find((r) => r.assets || r.debts);

  return (
    <>
      <div className="page-head">
        <h1>Rapporter</h1>
      </div>

      <div className="stat-tiles">
        <div className="card stat">
          <div className="small muted">Formue</div>
          <div className="v num">{nw ? kr(nw.netWorth) : '–'}</div>
          {nw && nwYearAgo && (
            <div className="small muted">
              {nw.netWorth >= nwYearAgo.netWorth ? '▲' : '▼'} {kr(Math.abs(nw.netWorth - nwYearAgo.netWorth))} siden {shortMonth(nwYearAgo.month)}
            </div>
          )}
        </div>
        <div className="card stat">
          <div className="small muted">Snittinntekt per måned</div>
          <div className="v num">{kr(Math.round(avgIncome / 100) * 100)}</div>
          <div className="small muted">siste 3 hele måneder</div>
        </div>
        <div className="card stat">
          <div className="small muted">Snittforbruk per måned</div>
          <div className="v num">{kr(Math.round(avgSpend / 100) * 100)}</div>
          <div className="small muted">siste 3 hele måneder</div>
        </div>
        <div className="card stat">
          <div className="small muted">Sparerate</div>
          <div className="v num">{savingsRate === null ? '–' : `${Math.round(savingsRate * 100)} %`}</div>
          <div className="small muted">av inntekten spart</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <ChartCard
          title="Hvor pengene gikk"
          sub={
            <span className="row" style={{ gap: 4 }}>
              <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Forrige måned">
                <Icon name="left" size={16} />
              </button>
              {monthLabel(month)}
              <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Neste måned" disabled={month >= currentMonth()}>
                <Icon name="right" size={16} />
              </button>
            </span>
          }
          table={
            <SimpleTable
              head={['Kategori', 'Brukt', 'Vanlig (snitt 3 mnd)']}
              rows={spending.map((r) => [r.name, kr(r.spent), kr(r.usual)])}
            />
          }
        >
          <SpendingBars rows={spending} month={month} />
        </ChartCard>

        <ChartCard
          title="Inntekt og forbruk"
          sub="Siste 12 måneder · overføringer mellom egne kontoer er holdt utenfor"
          legend={[
            { label: 'Inntekt', color: 'var(--series-1)' },
            { label: 'Forbruk', color: 'var(--series-2)' },
          ]}
          table={
            <SimpleTable
              head={['Måned', 'Inntekt', 'Forbruk', 'Spart']}
              rows={flow.map((r) => [monthLabel(r.month), kr(r.income), kr(r.spending), kr(r.income - r.spending)])}
            />
          }
        >
          <CashflowChart rows={flow} />
        </ChartCard>

        <ChartCard
          title="Formue"
          sub="Alle kontoer, også oppfølgingskontoer som boliglån og sparing"
          table={
            <SimpleTable
              head={['Måned', 'Eiendeler', 'Gjeld', 'Formue']}
              rows={worth.map((r) => [monthLabel(r.month), kr(r.assets), kr(-r.debts), kr(r.netWorth)])}
            />
          }
        >
          <NetWorthChart rows={worth} />
        </ChartCard>
      </div>
    </>
  );
}

function ChartCard({
  title,
  sub,
  legend,
  table,
  children,
}: {
  title: string;
  sub?: ReactNode;
  legend?: Array<{ label: string; color: string }>;
  table: ReactNode;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="spacer">
          <h3 style={{ margin: 0 }}>{title}</h3>
          {sub && <div className="small muted">{sub}</div>}
        </div>
        <button className="btn ghost sm" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Vis diagram' : 'Vis tabell'}
        </button>
      </div>
      {legend && !asTable && (
        <div className="legend" style={{ marginBottom: 8 }}>
          {legend.map((l) => (
            <span key={l.label}>
              <span className="swatch" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
      {asTable ? table : children}
    </div>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i ? 'right' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={j ? 'right num' : ''}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal bars, one hue: magnitude per category. The tick shows what's normal for you. */
function SpendingBars({ rows, month }: { rows: SpendRow[]; month: string }) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length) return <div className="empty">Ingen utgifter registrert i {monthLabel(month).toLowerCase()}.</div>;
  const max = Math.max(...rows.map((r) => Math.max(r.spent, r.usual)));
  const total = rows.reduce((s, r) => s + r.spent, 0);
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 6 }}>
        Totalt <Money value={-total} /> · den mørke streken viser det vanlige (snitt siste 3 måneder). Klikk på en stolpe for å se transaksjonene.
      </div>
      {rows.map((r) => {
        const diff = r.usual ? (r.spent - r.usual) / r.usual : null;
        return (
          <div
            key={r.id}
            className="hbar-row"
            style={{ cursor: 'pointer', background: hover === r.id ? 'var(--surface-2)' : undefined, borderRadius: 6 }}
            onMouseEnter={() => setHover(r.id)}
            onMouseLeave={() => setHover(null)}
            onClick={() => navigate(`/transactions?category=${r.id}&month=${month}`)}
          >
            <div className="ellipsis small" style={{ fontWeight: 500 }}>
              {r.name}
            </div>
            <div className="hbar-track">
              <div className="hbar-fill" style={{ width: `${(r.spent / max) * 100}%` }} />
              {r.usual > 0 && <div className="hbar-usual" style={{ left: `${(r.usual / max) * 100}%` }} />}
              {hover === r.id && (
                <div className="tooltip" style={{ left: `${Math.min(80, Math.max(20, (r.spent / max) * 100))}%`, top: 0 }}>
                  <strong>{r.name}</strong>
                  <div>Brukt {kr(r.spent)}</div>
                  <div className="muted">Vanlig {kr(r.usual)}</div>
                  <div className="muted">{Math.round((r.spent / total) * 100)} % av forbruket</div>
                </div>
              )}
            </div>
            <div className="small num" style={{ textAlign: 'right', minWidth: 110 }}>
              {kr(r.spent)}
              {diff !== null && Math.abs(diff) >= 0.2 && (
                <div className="faint" style={{ fontSize: 11 }}>
                  {diff > 0 ? '▲' : '▼'} {Math.round(Math.abs(diff) * 100)} % mot vanlig
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function useWidth() {
  // A callback ref, because the chart's div only mounts once data has arrived.
  const [w, setW] = useState(640);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    observer.current = new ResizeObserver(([e]) => setW(e.contentRect.width));
    observer.current.observe(el);
  }, []);
  return [ref, w] as const;
}

/** Grouped columns: income and spending side by side per month, one shared axis. */
function CashflowChart({ rows }: { rows: FlowRow[] }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const pad = { top: 10, right: 8, bottom: 24, left: 44 };
  const ticks = useMemo(() => niceTicks(Math.max(1, ...rows.flatMap((r) => [r.income, r.spending]))), [rows]);
  const max = ticks[ticks.length - 1] || 1;
  if (!rows.length) return null;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / rows.length;
  const barW = Math.max(3, Math.min(18, (band - 10) / 2));
  const y = (v: number) => pad.top + innerH - (Math.max(0, v) / max) * innerH;
  // Bars with a rounded data end and a square baseline end.
  const bar = (x: number, v: number) => {
    const top = y(v);
    const h = pad.top + innerH - top;
    if (h <= 0) return '';
    const r = Math.min(4, h, barW / 2);
    return `M${x},${pad.top + innerH}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${pad.top + innerH}Z`;
  };
  const h = hover !== null ? rows[hover] : null;
  return (
    <div className="chart" ref={ref}>
      <svg height={height} role="img" aria-label="Inntekt og forbruk per måned">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.left - 6} y={y(t) + 4} textAnchor="end">
              {axisKr(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cx = pad.left + band * i + band / 2;
          return (
            <g key={r.month}>
              <path d={bar(cx - barW - 1, r.income)} fill="var(--series-1)" />
              <path d={bar(cx + 1, r.spending)} fill="var(--series-2)" />
              {(rows.length <= 12 || i % 2 === 0) && (
                <text className="axis" x={cx} y={height - 6} textAnchor="middle">
                  {shortMonth(r.month)}
                </text>
              )}
              <rect
                className={`hit ${hover === i ? 'on' : ''}`}
                x={pad.left + band * i}
                y={pad.top}
                width={band}
                height={innerH}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div className="tooltip" style={{ left: pad.left + band * hover + band / 2, top: y(Math.max(h.income, h.spending)) }}>
          <strong>{monthLabel(h.month)}</strong>
          <div>
            <span className="swatch" style={{ background: 'var(--series-1)' }} />
            Inntekt {kr(h.income)}
          </div>
          <div>
            <span className="swatch" style={{ background: 'var(--series-2)' }} />
            Forbruk {kr(h.spending)}
          </div>
          <div className="muted">
            {h.income >= h.spending ? 'Spart' : 'Brukt for mye'} {kr(Math.abs(h.income - h.spending))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Single line with a crosshair tooltip. */
function NetWorthChart({ rows }: { rows: WorthRow[] }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const height = 200;
  const pad = { top: 12, right: 12, bottom: 24, left: 52 };
  if (!rows.length) return null;
  const values = rows.map((r) => r.netWorth);
  const lo = Math.min(0, ...values);
  const hi = Math.max(1, ...values);
  const ticksPos = niceTicks(hi - lo);
  const step = ticksPos[1] ?? 1;
  const min = Math.floor(lo / step) * step;
  const max = min + ticksPos[ticksPos.length - 1] + (lo < 0 ? step : 0);
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (rows.length === 1 ? innerW / 2 : (innerW * i) / (rows.length - 1));
  const y = (v: number) => pad.top + innerH - ((v - min) / (max - min || 1)) * innerH;
  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)},${y(r.netWorth)}`).join('');
  const h = hover !== null ? rows[hover] : null;

  return (
    <div
      className="chart"
      ref={ref}
      onMouseMove={(e) => {
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const px = e.clientX - rect.left;
        const i = Math.round(((px - pad.left) / innerW) * (rows.length - 1));
        setHover(Math.max(0, Math.min(rows.length - 1, i)));
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg height={height} role="img" aria-label="Formue de siste 12 månedene">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} style={t === 0 ? { stroke: 'var(--faint)' } : undefined} />
            <text className="axis" x={pad.left - 6} y={y(t) + 4} textAnchor="end">
              {axisKr(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          rows.length <= 12 || i % 2 === 0 ? (
            <text key={r.month} className="axis" x={x(i)} y={height - 6} textAnchor="middle">
              {shortMonth(r.month)}
            </text>
          ) : null,
        )}
        <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {h && hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--faint)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(h.netWorth)} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          </>
        )}
        <circle cx={x(rows.length - 1)} cy={y(values[values.length - 1])} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
      </svg>
      {h && hover !== null && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(hover), 90), width - 90), top: y(h.netWorth) }}>
          <strong>{monthLabel(h.month)}</strong>
          <div>Formue {kr(h.netWorth)}</div>
          <div className="muted">Eiendeler {kr(h.assets)}</div>
          <div className="muted">Gjeld {kr(-h.debts)}</div>
        </div>
      )}
    </div>
  );
}
