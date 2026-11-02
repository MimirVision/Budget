/**
 * Oversikt, the deeper cards (inspired by Copilot, Monarch and Emma):
 * - Kontantstrøm: twelve months of money in against money out, the savings rate and the best month.
 * - Over og under vanlig: which categories run above or below their usual level, adjusted for how far into the
 *   month we are, so a running month isn't compared with three whole ones.
 * - Faste kostnader: what the fixed bills cost per month and per year, the subscriptions, and what's due next.
 * - Fordeling: where the period's money went, by group, as a donut.
 * Every number comes from the same reports the rest of the app uses; nothing is calculated differently here.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dayLabel, kr, monthLabel, relativeDay } from '../format';
import { useStore } from '../store';
import { CashflowChart, ChartCard, SimpleTable, type FlowRow } from '../components/charts';
import { Tile, groupTint } from '../components/apple';


export function CashflowCard() {
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  const { version } = useStore();
  useEffect(() => {
    api.get<FlowRow[]>('/reports/cashflow?months=12').then(setRows);
  }, [version]);
  if (!rows) return null;
  // Skip the empty months before the app had any data.
  const first = rows.findIndex((r) => r.income || r.spending);
  const shown = first < 0 ? [] : rows.slice(first);
  if (shown.length < 2) return null;
  const done = shown.slice(0, -1); // the running month isn't finished
  const income = done.reduce((s, r) => s + r.income, 0);
  const net = done.reduce((s, r) => s + r.income - r.spending, 0);
  const rate = income > 0 ? Math.round((net / income) * 100) : null;
  const best = done.reduce<FlowRow | null>((b, r) => (!b || r.income - r.spending > b.income - b.spending ? r : b), null);
  return (
    <ChartCard
      title="Kontantstrøm"
      sub="Inn og ut per måned, siste 12 måneder"
      legend={[
        { label: 'Inn', color: 'var(--series-1)' },
        { label: 'Ut', color: 'var(--series-2)' },
      ]}
      table={
        <SimpleTable
          head={['Måned', 'Inn', 'Ut', 'Til overs']}
          rows={shown.map((r) => [monthLabel(r.month), kr(r.income), kr(r.spending), kr(r.income - r.spending)])}
        />
      }
    >
      <div className="kpis">
        <div>
          <span>Snitt til overs</span>
          <strong className={net >= 0 ? 'good-text' : 'bad-text'}>{done.length ? kr(Math.round(net / done.length)) : '–'}</strong>
          <small>per hele måned</small>
        </div>
        <div>
          <span>Sparerate</span>
          <strong>{rate !== null ? `${rate} %` : '–'}</strong>
          <small>av inntekten</small>
        </div>
        <div>
          <span>Beste måned</span>
          <strong>{best ? monthLabel(best.month).split(' ')[0] : '–'}</strong>
          <small>{best ? `${kr(best.income - best.spending)} til overs` : ''}</small>
        </div>
      </div>
      <CashflowChart rows={shown} />
    </ChartCard>
  );
}

interface SpendRow {
  id: number;
  name: string;
  group_name: string;
  spent: number;
  usual: number;
}

/** Categories above or below their usual level, paced for a running month. */
export function VsUsualCard({ month, pace, fixedIds }: { month: string; pace: number; fixedIds: Set<number> }) {
  const [rows, setRows] = useState<SpendRow[] | null>(null);
  const { version } = useStore();
  useEffect(() => {
    api.get<SpendRow[]>(`/reports/spending?month=${month}`).then(setRows);
  }, [month, version]);
  const items = useMemo(() => {
    if (!rows) return [];
    return rows
      // Fixed bills come once a month, so comparing them with a share of their usual amount would be noise.
      .filter((r) => !fixedIds.has(r.id) && (r.usual > 0 || r.spent > 0))
      .map((r) => {
        const expected = Math.round(r.usual * pace);
        return { ...r, expected, diff: r.spent - expected };
      })
      .filter((r) => Math.abs(r.diff) >= 5000) // under 50 kr isn't news
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 7);
  }, [rows, pace, fixedIds]);
  if (!rows) return null;
  const max = Math.max(1, ...items.map((i) => Math.abs(i.diff)));
  return (
    <div className="card card-pad">
      <h3 style={{ marginBottom: 0 }}>Over og under vanlig</h3>
      <div className="small muted">
        Hverdagsforbruk mot snittet de tre siste månedene{pace < 1 ? `, justert for at ${Math.round(pace * 100)} % av måneden er gått` : ''}
      </div>
      {items.length === 0 ? (
        <div className="small muted" style={{ marginTop: 12 }}>
          Alt er omtrent som vanlig.
        </div>
      ) : (
        <div className="diverge">
          {items.map((i) => {
            const t = groupTint(i.group_name);
            const w = (Math.abs(i.diff) / max) * 50;
            return (
              <Link key={i.id} to={`/transactions?category=${i.id}&month=${month}`} className="diverge-row">
                <span className="diverge-name">
                  <Tile color={t.color} letter={i.name} size={20} />
                  <span className="ellipsis">{i.name}</span>
                </span>
                <span className="diverge-track" aria-hidden="true">
                  <span className={`diverge-bar ${i.diff > 0 ? 'over' : 'under'}`} style={i.diff > 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
                </span>
                <span className={`diverge-val num ${i.diff > 0 ? 'bad-text' : 'good-text'}`}>
                  {i.diff > 0 ? '+' : '−'}
                  {kr(Math.abs(i.diff))}
                </span>
              </Link>
            );
          })}
          <div className="diverge-axis small faint">
            <span />
            <span className="diverge-axis-labels">
              <span>← Mindre</span>
              <span>Mer →</span>
            </span>
            <span />
          </div>
        </div>
      )}
    </div>
  );
}

interface BillLite {
  id: number;
  name: string;
  amount: number;
  every: number;
  monthly: number;
  due: string;
  category_name: string | null;
  paid: { date: string; amount: number } | null;
}

/** What the fixed costs add up to, the subscriptions, and the next bills. */
export function RecurringCard() {
  const [data, setData] = useState<{ bills: BillLite[]; monthlyTotal: number } | null>(null);
  const { version } = useStore();
  useEffect(() => {
    api.get<{ bills: BillLite[]; monthlyTotal: number }>('/bills?light=1').then(setData);
  }, [version]);
  if (!data) return null;
  if (!data.bills.length)
    return (
      <div className="card card-pad">
        <h3 style={{ marginBottom: 0 }}>Faste kostnader</h3>
        <div className="small muted" style={{ marginTop: 6 }}>
          Ingen faste regninger lagt inn ennå. <Link to="/bills">Legg dem inn</Link>, så ser du hva de koster i året og hva som kommer.
        </div>
      </div>
    );
  const subs = data.bills.filter((b) => /abonn|stream|tv|musikk/i.test(`${b.category_name ?? ''} ${b.name}`));
  const subsYear = subs.reduce((s, b) => s + b.monthly * 12, 0);
  const today = new Date().toISOString().slice(0, 10);
  const next = data.bills
    .filter((b) => !b.paid && b.due >= today)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 4);
  return (
    <div className="card card-pad">
      <h3 style={{ marginBottom: 0 }}>Faste kostnader</h3>
      <div className="small muted">Fra Faste regninger</div>
      <div className="kpis">
        <div>
          <span>Per måned</span>
          <strong>{kr(data.monthlyTotal)}</strong>
          <small>{data.bills.length} regninger</small>
        </div>
        <div>
          <span>Per år</span>
          <strong>{kr(data.monthlyTotal * 12)}</strong>
          <small>årlige regnet inn</small>
        </div>
        <div>
          <span>Abonnementer</span>
          <strong>{kr(subsYear)}</strong>
          <small>{subs.length ? `i året, ${subs.length} stk.` : 'ingen funnet'}</small>
        </div>
      </div>
      {next.length > 0 && (
        <div className="list compact">
          {next.map((b) => (
            <Link key={b.id} to="/bills" className="list-item" style={{ color: 'inherit', textDecoration: 'none' }}>
              <span className="grow ellipsis">
                <strong style={{ fontWeight: 550 }}>{b.name}</strong>
                <span className="small muted"> · {relativeDay(b.due).toLowerCase() === dayLabel(b.due).toLowerCase() ? dayLabel(b.due) : relativeDay(b.due)}</span>
              </span>
              <span className="num">{kr(b.amount)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where the period's money went, by group, as a donut. */
export function DonutCard({ groups, title = 'Fordeling' }: { groups: Array<{ id: number | null; name: string; spent: number }>; title?: string }) {
  const parts = groups.filter((g) => g.spent > 0).sort((a, b) => b.spent - a.spent);
  const total = parts.reduce((s, g) => s + g.spent, 0);
  if (total <= 0) return null;
  const size = 148;
  const stroke = 22;
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="card card-pad">
      <h3 style={{ marginBottom: 0 }}>{title}</h3>
      <div className="small muted">Forbruket i perioden, per gruppe</div>
      <div className="donut-wrap">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={parts.map((p) => `${p.name} ${Math.round((p.spent / total) * 100)} %`).join(', ')}>
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {parts.map((p) => {
              const share = p.spent / total;
              const seg = (
                <circle
                  key={p.id ?? 'none'}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={p.id === null ? 'var(--faint)' : groupTint(p.name).color}
                  strokeWidth={stroke}
                  strokeDasharray={`${Math.max(0, share * len - 2)} ${len}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += share * len;
              return seg;
            })}
          </g>
          <text x="50%" y="47%" textAnchor="middle" className="donut-total">
            {kr(total).replace(/,\d+/, '')}
          </text>
          <text x="50%" y="60%" textAnchor="middle" className="donut-label">
            totalt
          </text>
        </svg>
        <div className="donut-legend">
          {parts.map((p) => (
            <div key={p.id ?? 'none'}>
              <span className="swatch" style={{ background: p.id === null ? 'var(--faint)' : groupTint(p.name).color }} />
              <span className="grow ellipsis">{p.name}</span>
              <span className="num">{kr(p.spent)}</span>
              <span className="num faint">{Math.round((p.spent / total) * 100)} %</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


