/** Shared chart pieces (single axis, thin marks, hover tooltips, table view), used by the Oversikt tab. */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { kr, monthLabel, shortMonth } from '../format';

export interface SpendRow {
  id: number;
  name: string;
  group_name: string;
  spent: number;
  usual: number;
}
export interface FlowRow {
  month: string;
  income: number;
  spending: number;
}
export interface WorthRow {
  month: string;
  assets: number;
  debts: number;
  netWorth: number;
}

export const compact = new Intl.NumberFormat('nb-NO', { notation: 'compact', maximumFractionDigits: 1 });
export const axisKr = (ore: number) => compact.format(ore / 100);

/** "Nice" axis maximum and ticks, so gridlines land on round numbers. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

export function ChartCard({
  title,
  sub,
  legend,
  table,
  children,
}: {
  title: string;
  sub?: ReactNode;
  legend?: Array<{ label: string; color: string; dashed?: boolean }>;
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
              {l.dashed ? (
                <span className="swatch-line" style={{ borderColor: l.color }} />
              ) : (
                <span className="swatch" style={{ background: l.color }} />
              )}
              {l.label}
            </span>
          ))}
        </div>
      )}
      {asTable ? table : children}
    </div>
  );
}

export function SimpleTable({ head, rows }: { head: string[]; rows: string[][] }) {
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

export function useWidth() {
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
export function CashflowChart({ rows }: { rows: FlowRow[] }) {
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
export function NetWorthChart({ rows }: { rows: WorthRow[] }) {
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

/**
 * Cumulative spending through the month, with last month as a dashed reference line.
 * Answers "are we on track?" at a glance; crosshair tooltip on hover/touch.
 */
export function PaceChart({ rows }: { rows: Array<{ day: number; cum: number | null; prevCum: number | null }> }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const height = 210;
  const pad = { top: 12, right: 12, bottom: 24, left: 48 };
  const max = Math.max(1, ...rows.flatMap((r) => [r.cum ?? 0, r.prevCum ?? 0]));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const x = (day: number) => pad.left + ((day - 1) / Math.max(1, rows.length - 1)) * innerW;
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const line = (key: 'cum' | 'prevCum') =>
    rows
      .filter((r) => r[key] !== null)
      .map((r, i) => `${i ? 'L' : 'M'}${x(r.day)},${y(r[key]!)}`)
      .join('');
  const lastNow = [...rows].reverse().find((r) => r.cum !== null);
  const h = hover !== null ? rows[hover] : null;
  const pick = (clientX: number, el: HTMLElement) => {
    const px = clientX - el.getBoundingClientRect().left;
    const i = Math.round(((px - pad.left) / innerW) * (rows.length - 1));
    setHover(Math.max(0, Math.min(rows.length - 1, i)));
  };
  return (
    <div
      className="chart"
      ref={ref}
      onMouseMove={(e) => pick(e.clientX, e.currentTarget)}
      onTouchMove={(e) => pick(e.touches[0].clientX, e.currentTarget)}
      onTouchStart={(e) => pick(e.touches[0].clientX, e.currentTarget)}
      onMouseLeave={() => setHover(null)}
    >
      <svg height={height} role="img" aria-label="Forbruk gjennom måneden, sammenlignet med forrige måned">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.left - 6} y={y(t) + 4} textAnchor="end">
              {axisKr(t)}
            </text>
          </g>
        ))}
        {[1, 8, 15, 22, rows.length].map((d) => (
          <text key={d} className="axis" x={x(d)} y={height - 6} textAnchor="middle">
            {d}.
          </text>
        ))}
        <path d={line('prevCum')} fill="none" stroke="var(--faint)" strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" />
        <path d={line('cum')} fill="none" stroke="var(--series-1)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {lastNow && hover === null && <circle cx={x(lastNow.day)} cy={y(lastNow.cum!)} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />}
        {h && hover !== null && (
          <>
            <line x1={x(h.day)} x2={x(h.day)} y1={pad.top} y2={pad.top + innerH} stroke="var(--faint)" strokeDasharray="3 3" />
            {h.prevCum !== null && <circle cx={x(h.day)} cy={y(h.prevCum)} r={4} fill="var(--faint)" stroke="var(--surface)" strokeWidth={2} />}
            {h.cum !== null && <circle cx={x(h.day)} cy={y(h.cum)} r={5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />}
          </>
        )}
      </svg>
      {h && hover !== null && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(h.day), 90), width - 90), top: y(Math.max(h.cum ?? 0, h.prevCum ?? 0)) }}>
          <strong>{h.day}. i måneden</strong>
          {h.cum !== null && <div>Denne måneden {kr(h.cum)}</div>}
          {h.prevCum !== null && <div className="muted">Forrige måned {kr(h.prevCum)}</div>}
        </div>
      )}
    </div>
  );
}
