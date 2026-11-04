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
import { Icon } from '../components/ui';


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

/**
 * Faste kostnader: this month's fixed bills (paid, still to come), the next payments, what the fixed costs go to,
 * the subscriptions per year, and how much of the expected pay the fixed costs take.
 */
export function RecurringCard() {
  const [data, setData] = useState<{ bills: BillLite[]; monthlyTotal: number } | null>(null);
  const [income, setIncome] = useState<number>(0);
  const { version } = useStore();
  useEffect(() => {
    api.get<{ bills: BillLite[]; monthlyTotal: number }>('/bills?light=1').then(setData);
    api.get<{ expected: number }>('/incomes').then((r) => setIncome(r.expected)).catch(() => setIncome(0));
  }, [version]);
  if (!data) return null;
  if (!data.bills.length)
    return (
      <div className="card card-pad">
        <h3 style={{ marginBottom: 0 }}>Faste kostnader</h3>
        <div className="small muted" style={{ marginTop: 6 }}>
          Ingen faste regninger lagt inn ennå. <Link to="/bills">Legg dem inn</Link>, så ser du hva de koster, hva som er betalt og hva som kommer.
        </div>
      </div>
    );
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const thisMonth = data.bills.filter((b) => b.due.slice(0, 7) === month || b.paid?.date.slice(0, 7) === month);
  const paid = thisMonth.filter((b) => b.paid);
  const left = thisMonth.filter((b) => !b.paid);
  const paidSum = paid.reduce((s, b) => s + (b.paid?.amount ?? 0), 0);
  const leftSum = left.reduce((s, b) => s + b.amount, 0);
  const share = paidSum + leftSum > 0 ? paidSum / (paidSum + leftSum) : 0;
  const next = data.bills
    .filter((b) => !b.paid)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 4);
  // What the fixed costs go to, per category, as a monthly amount.
  const byCat = new Map<string, number>();
  for (const b of data.bills) byCat.set(b.category_name ?? 'Uten kategori', (byCat.get(b.category_name ?? 'Uten kategori') ?? 0) + b.monthly);
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const catMax = Math.max(1, ...cats.map((c) => c[1]));
  const subs = data.bills.filter((b) => /abonn|stream|tv|musikk/i.test(`${b.category_name ?? ''} ${b.name}`));
  const subsYear = subs.reduce((s, b) => s + b.monthly * 12, 0);
  const ofIncome = income > 0 ? Math.round((data.monthlyTotal / income) * 100) : null;
  const when = (d: string) => {
    const days = Math.round((new Date(`${d}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86400000);
    return days < 0 ? { text: `${-days} d over`, tone: 'bad' } : days === 0 ? { text: 'i dag', tone: 'warn' } : { text: `om ${days} d`, tone: days <= 3 ? 'warn' : '' };
  };
  return (
    <div className="card card-pad fc">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>Faste kostnader</h3>
        <Link to="/bills" className="small">
          Se alle
        </Link>
      </div>
      <div className="small muted">
        {kr(data.monthlyTotal)} i måneden · {kr(data.monthlyTotal * 12)} i året
        {ofIncome !== null && <> · {ofIncome} % av forventet inntekt</>}
      </div>

      <div className="fc-month">
        <div className="fc-split">
          <span>
            <small>Betalt i {monthLabel(month).split(' ')[0].toLowerCase()}</small>
            <strong className="num good-text">{kr(paidSum)}</strong>
            <small>{paid.length} av {thisMonth.length} regninger</small>
          </span>
          <span style={{ textAlign: 'right' }}>
            <small>Igjen</small>
            <strong className="num">{kr(leftSum)}</strong>
            <small>{left.length} regninger</small>
          </span>
        </div>
        <div className="fc-bar" aria-hidden="true">
          <span style={{ width: `${share * 100}%` }} />
        </div>
      </div>

      {next.length > 0 && (
        <div className="fc-next">
          <div className="fc-label">Neste betalinger</div>
          {next.map((b) => {
            const d = new Date(`${b.due}T12:00:00`);
            const w = when(b.due);
            return (
              <Link key={b.id} to="/bills" className="fc-item">
                <span className="fc-date" aria-hidden="true">
                  <small>{d.toLocaleDateString('nb-NO', { month: 'short' }).replace('.', '')}</small>
                  <strong>{d.getDate()}</strong>
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: 'block', fontWeight: 550 }}>
                    {b.name}
                  </span>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>
                    {b.category_name ?? 'Uten kategori'}
                  </span>
                </span>
                <span className="fc-amount">
                  <strong className="num">{kr(b.amount)}</strong>
                  <small className={w.tone === 'bad' ? 'bad-text' : w.tone === 'warn' ? 'warn-text' : 'muted'}>{w.text}</small>
                </span>
              </Link>
            );
          })}
        </div>
      )}

      <div className="fc-cats">
        <div className="fc-label">Hva de går til, per måned</div>
        {cats.map(([name, v]) => (
          <div key={name} className="fc-cat">
            <span className="ellipsis">{name}</span>
            <span className="fc-cat-track" aria-hidden="true">
              <span style={{ width: `${(v / catMax) * 100}%` }} />
            </span>
            <span className="num">{kr(v)}</span>
          </div>
        ))}
      </div>

      {subs.length > 0 && (
        <div className="fc-subs small">
          <Icon name="sparkle" size={14} /> Abonnementer: <strong>{kr(subsYear)}</strong> i året ({subs.length} stk.)
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


