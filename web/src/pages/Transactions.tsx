import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Transaction } from '../api';
import { dayLabel, monthLabel } from '../format';
import { useStore } from '../store';
import { CategorySelect, Icon, Money, useToast } from '../components/ui';
import { TransactionEditor } from '../components/TransactionEditor';

const PAGE = 100;

export default function TransactionsPage() {
  const [params, setParams] = useSearchParams();
  const { summary, refresh } = useStore();
  const toast = useToast();
  const [rows, setRows] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null);

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
    },
    [account, category, month, q],
  );
  useEffect(() => {
    load();
  }, [load]);

  // Search as you type, but not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => search !== q && setFilter('q', search), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const setCategory = async (t: Transaction, categoryId: number | null) => {
    await api.patch(`/transactions/${t.id}`, { category_id: categoryId });
    await Promise.all([load(), refresh()]);
    toast('Category updated');
  };

  if (!summary) return null;
  const acc = summary.accounts.find((a) => String(a.id) === account);
  const cat = summary.categories.find((c) => String(c.id) === category);
  const filtered = !!(account || category || month || q);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{acc ? acc.name : 'Transactions'}</h1>
          <div className="sub">
            {acc ? (
              <>
                Balance <Money value={acc.balance} />
                {acc.bank_balance !== null && acc.bank_balance !== acc.balance && (
                  <span style={{ color: 'var(--warn)' }}>
                    {' '}
                    · bank says <Money value={acc.bank_balance} />
                  </span>
                )}
              </>
            ) : (
              `${total} transaction${total === 1 ? '' : 's'}`
            )}
          </div>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} /> Add transaction
        </button>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: '1 1 220px' }}>
          <input className="input" placeholder="Search payee, text or amount" value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 34 }} />
          <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--faint)' }}>
            <Icon name="search" size={18} />
          </span>
        </div>
        <select className="select" style={{ flex: '0 1 200px' }} value={account} onChange={(e) => setFilter('account', e.target.value)}>
          <option value="">All accounts</option>
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
            placeholder="All categories"
            extra={<option value="none">Uncategorized</option>}
          />
        </div>
        <input className="input" type="month" style={{ flex: '0 1 170px' }} value={month} onChange={(e) => setFilter('month', e.target.value)} aria-label="Month" />
        {filtered && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setSearch('');
              setParams({});
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {category === 'none' && <div className="callout info small" style={{ marginBottom: 12 }}>Showing transactions with no category.</div>}
      {month && <div className="small muted" style={{ marginBottom: 8 }}>{monthLabel(month)}</div>}

      <div className="card table-wrap">
        {rows.length === 0 ? (
          <div className="empty">
            <div className="emoji">🧾</div>
            {filtered ? 'Nothing matches those filters.' : 'No transactions yet. Connect a bank or import a CSV on the Accounts page.'}
          </div>
        ) : (
          <table className="table tx-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th className="hide-sm">Account</th>
                <th className="hide-sm">Category</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => setEditing(t)}>
                  <td className="num muted" style={{ width: 90 }}>
                    {dayLabel(t.date)}
                  </td>
                  <td style={{ maxWidth: 280 }}>
                    <div className="ellipsis" style={{ fontWeight: 500 }}>
                      {t.payee || t.raw_description}
                      {!t.reviewed && <span className="chip brand" style={{ marginLeft: 6 }}>new</span>}
                    </div>
                    <div className="small muted ellipsis show-sm">
                      {t.transfer_id
                        ? `Transfer ${t.amount < 0 ? 'to' : 'from'} ${t.transfer_account_name}`
                        : t.splits.length
                          ? `Split (${t.splits.length})`
                          : t.category_name ?? (t.suggested_category_name ? `${t.suggested_category_name}?` : 'Uncategorized')}
                      {' · '}
                      {t.account_name}
                    </div>
                    {t.memo && <div className="small faint ellipsis">{t.memo}</div>}
                  </td>
                  <td className="hide-sm muted">{t.account_name}</td>
                  <td className="hide-sm" onClick={(e) => e.stopPropagation()} style={{ minWidth: 170 }}>
                    {t.transfer_id ? (
                      <span className="chip" onClick={() => setEditing(t)} style={{ cursor: 'pointer' }}>
                        <Icon name="swap" size={12} /> {t.amount < 0 ? 'To' : 'From'} {t.transfer_account_name}
                      </span>
                    ) : t.splits.length ? (
                      <span className="chip" onClick={() => setEditing(t)} style={{ cursor: 'pointer' }}>
                        <Icon name="split" size={12} /> Split ({t.splits.length})
                      </span>
                    ) : (
                      <CategorySelect
                        className="select"
                        categories={summary.categories}
                        value={t.category_id}
                        amount={t.amount}
                        onChange={(id) => setCategory(t, id)}
                        placeholder={t.suggested_category_name ? `${t.suggested_category_name}?` : 'Uncategorized'}
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
      {rows.length < total && (
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <button className="btn" onClick={() => load(rows.length)}>
            Show more ({total - rows.length} left)
          </button>
        </div>
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
