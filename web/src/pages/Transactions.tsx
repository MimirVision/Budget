import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Transaction } from '../api';
import { dayLabel, monthLabel, relativeDay } from '../format';
import { useStore } from '../store';
import { useIsMobile } from '../hooks';
import { CategorySelect, Icon, Money, useToast } from '../components/ui';
import { TransactionEditor } from '../components/TransactionEditor';

const PAGE = 100;

export default function TransactionsPage() {
  const [params, setParams] = useSearchParams();
  const { summary, refresh, version } = useStore();
  const mobile = useIsMobile();
  const [showFilters, setShowFilters] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const toast = useToast();
  const [rows, setRows] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null);
  // Velg: tick several transactions and change them together.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const stopSelecting = () => {
    setSelecting(false);
    setSelected([]);
  };
  const open = (t: Transaction) => (selecting ? toggle(t.id) : setEditing(t));

  const account = params.get('account') ?? '';
  const category = params.get('category') ?? '';
  const month = params.get('month') ?? '';
  const q = params.get('q') ?? '';

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const load = useCallback(
    async (offset = 0) => {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (account) qs.set('account', account);
      if (category) qs.set('category', category);
      if (month) qs.set('month', month);
      if (q) qs.set('q', q);
      const r = await api.get<{ transactions: Transaction[]; total: number }>(`/transactions?${qs}`);
      setRows((prev) => (offset ? [...prev, ...r.transactions] : r.transactions));
      setTotal(r.total);
      if (!offset) {
        // Reserved purchases only make sense in the plain list, not when filtering by category, month or text.
        setPending(category || month || q ? [] : await api.get<Pending[]>(`/pending${account ? `?account=${account}` : ''}`));
      }
    },
    [account, category, month, q],
  );
  useEffect(() => {
    load();
  }, [load, version]);
  const [dupes, setDupes] = useState(0);
  useEffect(() => {
    api
      .get<{ groups: Array<{ rows: unknown[] }> }>('/duplicates')
      .then((d) => setDupes(d.groups.reduce((n, g) => n + g.rows.length - 1, 0)))
      .catch(() => setDupes(0));
  }, [version]);

  // Search as you type, but not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => search !== q && setFilter('q', search), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const setCategory = async (t: Transaction, categoryId: number | null) => {
    await api.patch(`/transactions/${t.id}`, { category_id: categoryId });
    await Promise.all([load(), refresh()]);
    toast('Kategori oppdatert');
  };

  if (!summary) return null;
  const acc = summary.accounts.find((a) => String(a.id) === account);
  const cat = summary.categories.find((c) => String(c.id) === category);
  const filtered = !!(account || category || month || q);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{acc ? acc.name : 'Transaksjoner'}</h1>
          <div className="sub">
            {acc ? (
              <>
                Saldo <Money value={acc.balance} />
                {acc.bank_balance !== null && acc.bank_balance !== acc.balance && (
                  <span style={{ color: 'var(--warn)' }}>
                    {' '}
                    · banken sier <Money value={acc.bank_balance} />
                  </span>
                )}
              </>
            ) : (
              `${total} ${total === 1 ? 'transaksjon' : 'transaksjoner'}`
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          {rows.length > 0 && (
            <button className={`btn ${mobile ? 'sm ' : ''}${selecting ? 'primary' : 'ghost'}`} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
              <Icon name="check" size={16} /> {selecting ? 'Ferdig' : 'Velg'}
            </button>
          )}
          {mobile ? (
            <button className="icon-btn" onClick={() => setEditing('new')} aria-label="Legg til manuelt" title="Legg til manuelt">
              <Icon name="plus" />
            </button>
          ) : (
            <button className="btn primary" onClick={() => setEditing('new')}>
              <Icon name="plus" size={16} /> Ny transaksjon
            </button>
          )}
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: '1 1 220px' }}>
          <input className="input" placeholder="Søk i mottaker, tekst eller beløp" value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 34 }} />
          <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--faint)' }}>
            <Icon name="search" size={18} />
          </span>
        </div>
        {mobile && (
          <button className={`btn ${showFilters ? 'primary' : ''}`} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            <Icon name="filter" size={16} /> Filter{[account, category, month].filter(Boolean).length ? ` (${[account, category, month].filter(Boolean).length})` : ''}
          </button>
        )}
        {(!mobile || showFilters) && (
        <>
        <select className="select" style={{ flex: '0 1 200px' }} value={account} onChange={(e) => setFilter('account', e.target.value)}>
          <option value="">Alle kontoer</option>
          {summary.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div style={{ flex: '0 1 220px' }}>
          <CategorySelect
            categories={summary.categories}
            value={category === 'none' ? 'none' : cat?.id ?? null}
            onChange={(id) => setFilter('category', id ? String(id) : '')}
            placeholder="Alle kategorier"
            extra={<option value="none">Uten kategori</option>}
          />
        </div>
        <input className="input" type="month" style={{ flex: '0 1 170px' }} value={month} onChange={(e) => setFilter('month', e.target.value)} aria-label="Måned" />
        </>
        )}
        {filtered && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setSearch('');
              setParams({});
            }}
          >
            Fjern filtre
          </button>
        )}
      </div>
      {category === 'none' && <div className="callout info small" style={{ marginBottom: 12 }}>Viser transaksjoner uten kategori.</div>}
      {month && <div className="small muted" style={{ marginBottom: 8 }}>{monthLabel(month)}</div>}

      {!filtered && dupes > 0 && (
        <Link to="/duplicates" className="callout warn small" style={{ marginBottom: 12, textDecoration: 'none', color: 'inherit' }}>
          <Icon name="alert" size={18} />
          <div>
            <strong>{dupes} {dupes === 1 ? 'transaksjon ser ut' : 'transaksjoner ser ut'} til å være registrert flere ganger.</strong>{' '}
            <span style={{ color: 'var(--brand-text)', fontWeight: 600 }}>Se og rydd opp →</span>
          </div>
        </Link>
      )}
      {pending.length > 0 && <PendingList items={pending} />}
      {mobile && rows.length > 0 ? (
        <DayList rows={rows} onOpen={open} selecting={selecting} selected={selected} />
      ) : (
      <div className="card table-wrap">
        {rows.length === 0 ? (
          <div className="empty">
            <div className="emoji">🧾</div>
            {filtered ? 'Ingenting passer med filtrene.' : 'Ingen transaksjoner ennå. Koble til en bank eller importer en CSV-fil under Kontoer.'}
          </div>
        ) : (
          <table className="table tx-table">
            <thead>
              <tr>
                {selecting && (
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      aria-label="Velg alle viste"
                      checked={selected.length > 0 && rows.every((t) => selected.includes(t.id))}
                      onChange={(e) => setSelected(e.target.checked ? rows.map((t) => t.id) : [])}
                    />
                  </th>
                )}
                <th>Dato</th>
                <th>Mottaker</th>
                <th className="hide-sm">Konto</th>
                <th className="hide-sm">Kategori</th>
                <th className="right">Beløp</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={`clickable ${selected.includes(t.id) ? 'selected' : ''}`} onClick={() => open(t)}>
                  {selecting && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Velg ${t.payee}`} checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
                    </td>
                  )}
                  <td className="num muted" style={{ width: 90 }}>
                    {dayLabel(t.date)}
                  </td>
                  <td style={{ maxWidth: 280 }}>
                    <div className="ellipsis" style={{ fontWeight: 500 }}>
                      {t.payee || t.raw_description}
                      {!t.reviewed && <span className="chip brand" style={{ marginLeft: 6 }}>ny</span>}
                      {!!t.attachment_count && (
                        <span className="txn-flags" style={{ marginLeft: 6 }} title={`${t.attachment_count} vedlegg`}>
                          <Icon name="clip" size={14} />
                        </span>
                      )}
                    </div>
                    <div className="small muted ellipsis show-sm">
                      {t.transfer_id
                        ? `Overføring ${t.amount < 0 ? 'til' : 'fra'} ${t.transfer_account_name}`
                        : t.splits.length
                          ? `Delt (${t.splits.length})`
                          : t.category_name ?? (t.suggested_category_name ? `${t.suggested_category_name}?` : 'Uten kategori')}
                      {' · '}
                      {t.account_name}
                    </div>
                    {t.memo && <div className="small faint ellipsis">{t.memo}</div>}
                  </td>
                  <td className="hide-sm muted">{t.account_name}</td>
                  <td className="hide-sm" onClick={(e) => !selecting && e.stopPropagation()} style={{ minWidth: 170 }}>
                    {selecting ? (
                      <span className="muted small">{t.transfer_id ? 'Overføring' : t.category_name ?? 'Uten kategori'}</span>
                    ) : t.transfer_id ? (
                      <span className="chip" onClick={() => setEditing(t)} style={{ cursor: 'pointer' }}>
                        <Icon name="swap" size={12} /> {t.amount < 0 ? 'Til' : 'Fra'} {t.transfer_account_name}
                      </span>
                    ) : t.splits.length ? (
                      <span className="chip" onClick={() => setEditing(t)} style={{ cursor: 'pointer' }}>
                        <Icon name="split" size={12} /> Delt ({t.splits.length})
                      </span>
                    ) : (
                      <CategorySelect
                        className="select"
                        categories={summary.categories}
                        value={t.category_id}
                        amount={t.amount}
                        onChange={(id) => setCategory(t, id)}
                        placeholder={t.suggested_category_name ? `${t.suggested_category_name}?` : 'Uten kategori'}
                      />
                    )}
                  </td>
                  <td className="right">
                    <Money value={t.amount} sign />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      )}
      {rows.length < total && (
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <button className="btn" onClick={() => load(rows.length)}>
            Vis flere ({total - rows.length} igjen)
          </button>
        </div>
      )}

      {selecting && (
        <BulkBar
          ids={selected}
          visible={rows.map((t) => t.id)}
          onSelectAll={() => setSelected(rows.map((t) => t.id))}
          onDone={async (msg) => {
            toast(msg);
            stopSelecting();
            await Promise.all([load(), refresh()]);
          }}
        />
      )}

      {editing && (
        <TransactionEditor
          txn={editing === 'new' ? undefined : editing}
          defaultAccountId={acc?.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

/** Phone list: grouped by day with a daily total, big rows, category under the payee. */
function DayList({
  rows,
  onOpen,
  selecting,
  selected,
}: {
  rows: Transaction[];
  onOpen: (t: Transaction) => void;
  selecting: boolean;
  selected: number[];
}) {
  const days: Array<{ date: string; items: Transaction[] }> = [];
  for (const t of rows) {
    const last = days[days.length - 1];
    if (last && last.date === t.date) last.items.push(t);
    else days.push({ date: t.date, items: [t] });
  }
  return (
    <div>
      {days.map((d) => {
        const total = d.items.filter((t) => !t.transfer_id).reduce((s, t) => s + t.amount, 0);
        return (
          <section key={d.date}>
            <div className="day-head">
              <span>{relativeDay(d.date)}</span>
              {total !== 0 && <Money value={total} />}
            </div>
            <div className="card" style={{ overflow: 'hidden' }}>
              {d.items.map((t) => (
                <button
                  key={t.id}
                  className={`tx-row ${selected.includes(t.id) ? 'selected' : ''}`}
                  onClick={() => onOpen(t)}
                  aria-pressed={selecting ? selected.includes(t.id) : undefined}
                >
                  <span className={`tx-avatar ${selecting && selected.includes(t.id) ? 'checked' : ''}`} aria-hidden="true">
                    {selecting ? (
                      selected.includes(t.id) ? <Icon name="check" size={16} /> : ''
                    ) : t.transfer_id ? (
                      <Icon name="swap" size={16} />
                    ) : (
                      (t.payee || t.raw_description || '?').trim().charAt(0).toUpperCase()
                    )}
                  </span>
                  <span className="tx-main">
                    <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                      {t.payee || t.raw_description}
                      {!t.reviewed && <span className="chip brand" style={{ marginLeft: 6 }}>ny</span>}
                      {!!t.attachment_count && (
                        <span className="txn-flags" style={{ marginLeft: 6 }} title={`${t.attachment_count} vedlegg`}>
                          <Icon name="clip" size={14} />
                        </span>
                      )}
                    </span>
                    <span className="small muted ellipsis" style={{ display: 'block' }}>
                      {t.transfer_id
                        ? `Overføring ${t.amount < 0 ? 'til' : 'fra'} ${t.transfer_account_name}`
                        : t.splits.length
                          ? `Delt (${t.splits.length})`
                          : t.category_name ?? (t.suggested_category_name ? `${t.suggested_category_name}?` : 'Uten kategori')}
                      {' · '}
                      {t.account_name}
                    </span>
                    {t.memo && (
                      <span className="small faint ellipsis" style={{ display: 'block' }}>
                        {t.memo}
                      </span>
                    )}
                  </span>
                  <span className="tx-amount">
                    <Money value={t.amount} sign />
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

interface Pending {
  id: number;
  account_name: string;
  date: string;
  amount: number;
  payee: string;
  description: string;
}

/** Card purchases the bank has reserved but not booked yet: visible right away, but not part of the budget. */
function PendingList({ items }: { items: Pending[] }) {
  const total = items.reduce((s, p) => s + p.amount, 0);
  return (
    <section className="pending" style={{ marginBottom: 14 }}>
      <div className="day-head">
        <span>Reservert · ikke bokført ennå</span>
        <Money value={total} />
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {items.map((p) => (
          <div key={p.id} className="tx-row pending-row" title={p.description}>
            <span className="tx-avatar" aria-hidden="true">
              <Icon name="calendar" size={16} />
            </span>
            <span className="tx-main">
              <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                {p.payee || p.description}
              </span>
              <span className="small muted ellipsis" style={{ display: 'block' }}>
                {dayLabel(p.date)} · {p.account_name} · telles når banken bokfører
              </span>
            </span>
            <span className="tx-amount">
              <Money value={p.amount} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The bar that appears while choosing: what to do with the ticked transactions. */
function BulkBar({
  ids,
  visible,
  onSelectAll,
  onDone,
}: {
  ids: number[];
  visible: number[];
  onSelectAll: () => void;
  onDone: (message: string) => void;
}) {
  const { summary } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: 'category' | 'reviewed' | 'delete', categoryId?: number | null) => {
    if (!ids.length) return;
    if (action === 'delete' && !confirm(`Slette ${ids.length} transaksjoner? Det kan ikke angres.`)) return;
    setBusy(true);
    try {
      let changed = 0;
      let skipped = 0;
      // In chunks: each request stays small (Cloudflare's free plan).
      for (let i = 0; i < ids.length; i += 90) {
        const r = await api.post<{ changed: number; skipped: number }>('/transactions/bulk', {
          ids: ids.slice(i, i + 90),
          action,
          category_id: categoryId,
        });
        changed += r.changed;
        skipped += r.skipped;
      }
      const verb = action === 'delete' ? 'Slettet' : action === 'reviewed' ? 'Godkjente' : 'Oppdaterte';
      onDone(`${verb} ${changed} transaksjoner${skipped ? ` (${skipped} overføringer hoppet over)` : ''}`);
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Endre valgte transaksjoner">
      <span className="bulk-count">
        <strong>{ids.length}</strong> valgt
        {ids.length < visible.length && (
          <button className="link-btn" onClick={onSelectAll}>
            Velg alle {visible.length}
          </button>
        )}
      </span>
      <div className="bulk-actions">
        <div style={{ minWidth: 170, flex: '1 1 170px' }}>
          <CategorySelect
            categories={summary?.categories ?? []}
            value={null}
            onChange={(id) => id && run('category', id)}
            placeholder="Sett kategori…"
          />
        </div>
        <button className="btn sm" disabled={busy || !ids.length} onClick={() => run('reviewed')}>
          <Icon name="check" size={15} /> Godkjenn
        </button>
        <button className="btn sm ghost danger" disabled={busy || !ids.length} onClick={() => run('delete')}>
          <Icon name="trash" size={15} /> Slett
        </button>
      </div>
    </div>
  );
}
