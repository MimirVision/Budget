import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Transaction } from '../api';
import { dayLabel, kr } from '../format';
import { useStore } from '../store';
import { CategorySelect, Icon, Money, useToast } from '../components/ui';
import { TransactionEditor } from '../components/TransactionEditor';

const SOURCE_LABEL: Record<string, string> = {
  rule: 'your rule',
  history: 'like last time',
  merchant: 'known store',
};

/** The inbox: every new transaction, from any source, shows up here once with a suggested category. */
export default function ReviewPage() {
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const { summary, refresh } = useStore();
  const toast = useToast();

  const load = useCallback(async () => {
    const r = await api.get<{ transactions: Transaction[] }>('/transactions?review=1&limit=500');
    setItems(r.transactions);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const after = async () => {
    await Promise.all([load(), refresh()]);
  };

  const undo = (id: number) => ({
    label: 'Undo',
    run: async () => {
      await api.patch(`/transactions/${id}`, { reviewed: false });
      await after();
    },
  });

  const approve = async (t: Transaction, categoryId: number | null, remember: boolean) => {
    // Optimistically hide it so the list feels instant.
    setItems((list) => list?.filter((x) => x.id !== t.id) ?? null);
    await api.patch(`/transactions/${t.id}`, categoryId ? { category_id: categoryId, remember } : { reviewed: true });
    const cat = summary?.categories.find((c) => c.id === categoryId);
    toast(cat ? `${t.payee} → ${cat.name}${remember ? ' (remembered)' : ''}` : `${t.payee} approved`, { action: undo(t.id) });
    await after();
  };

  const confirmTransfer = async (t: Transaction) => {
    setItems((list) => list?.filter((x) => x.id !== t.id && x.id !== t.suggested_transfer_id) ?? null);
    await api.patch(`/transactions/${t.id}`, { transfer_id: t.suggested_transfer_id });
    toast(`Marked as transfer ${t.amount < 0 ? 'to' : 'from'} ${t.suggested_transfer_account_name}`);
    await after();
  };

  const rejectTransfer = async (t: Transaction) => {
    // Forget the transfer guess and fall back to normal categorising.
    setItems((list) => list?.map((x) => (x.id === t.id ? { ...x, suggested_transfer_id: null, suggested_transfer_account_name: null } : x)) ?? null);
  };

  const approveAll = async () => {
    const r = await api.post<{ approved: number }>('/transactions/approve');
    toast(`Approved ${r.approved} transaction${r.approved === 1 ? '' : 's'}`);
    await after();
  };

  if (!items || !summary) return null;
  const withSuggestion = items.filter((t) => t.suggested_category_id || (t.suggested_transfer_id && t.suggested_transfer_account_name)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Review</h1>
          <div className="sub">
            {items.length ? `${items.length} new transaction${items.length === 1 ? '' : 's'} from your banks and imports` : 'All caught up'}
          </div>
        </div>
        {withSuggestion > 0 && (
          <button className="btn primary" onClick={approveAll}>
            <Icon name="check" size={16} /> Approve {withSuggestion} suggestion{withSuggestion === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="card empty">
          <div className="emoji">🎉</div>
          <h2 style={{ color: 'var(--text)' }}>Inbox zero</h2>
          <p>New transactions show up here when your banks sync or you import a file.</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link to="/" className="btn">
              Back to budget
            </Link>
            <Link to="/accounts" className="btn ghost">
              Sync or import
            </Link>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {items.map((t) => (
            <ReviewCard
              key={t.id}
              t={t}
              onApprove={approve}
              onTransfer={confirmTransfer}
              onRejectTransfer={rejectTransfer}
              onEdit={() => setEditing(t)}
            />
          ))}
        </div>
      )}

      {editing && (
        <TransactionEditor
          txn={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            after();
          }}
        />
      )}
    </>
  );
}

function ReviewCard({
  t,
  onApprove,
  onTransfer,
  onRejectTransfer,
  onEdit,
}: {
  t: Transaction;
  onApprove: (t: Transaction, categoryId: number | null, remember: boolean) => void;
  onTransfer: (t: Transaction) => void;
  onRejectTransfer: (t: Transaction) => void;
  onEdit: () => void;
}) {
  const { summary } = useStore();
  const [categoryId, setCategoryId] = useState<number | null>(t.suggested_category_id);
  const [remember, setRemember] = useState(false);
  const changed = categoryId !== t.suggested_category_id;
  const transferGuess = t.suggested_transfer_id && t.suggested_transfer_account_name;

  return (
    <div className="card review-card">
      <div style={{ minWidth: 0 }}>
        <div className="payee ellipsis">{t.payee || t.raw_description || 'Unknown'}</div>
        <div className="small muted">
          {dayLabel(t.date)} · {t.account_name}
          {t.suggested_category_name && !changed && (
            <>
              {' · '}
              <span className="chip brand">✨ {t.suggestion_source === 'merchant' && t.amount > 0 ? 'looks like salary' : SOURCE_LABEL[t.suggestion_source ?? ''] ?? 'suggested'}</span>
            </>
          )}
        </div>
        {t.raw_description && t.raw_description !== t.payee && (
          <div className="small faint ellipsis" title={t.raw_description}>
            {t.raw_description}
          </div>
        )}
      </div>
      <div className="amount">
        <Money value={t.amount} sign />
      </div>

      {transferGuess ? (
        <div className="actions">
          <div className="callout info small" style={{ flex: 1, padding: '8px 12px' }}>
            <Icon name="swap" size={18} />
            <div>
              Looks like {kr(Math.abs(t.amount))} moved {t.amount < 0 ? 'to' : 'from'} <strong>{t.suggested_transfer_account_name}</strong>
              {t.suggested_transfer_date ? ` (${dayLabel(t.suggested_transfer_date)})` : ''}. Transfers aren't spending.
            </div>
          </div>
          <button className="btn primary" onClick={() => onTransfer(t)}>
            Yes, transfer
          </button>
          <button className="btn ghost" onClick={() => onRejectTransfer(t)}>
            No
          </button>
        </div>
      ) : (
        <div className="actions">
          <CategorySelect categories={summary?.categories ?? []} value={categoryId} onChange={setCategoryId} amount={t.amount} />
          <button className="btn primary" disabled={!categoryId} onClick={() => onApprove(t, categoryId, remember)}>
            <Icon name="check" size={16} /> Approve
          </button>
          <button className="btn ghost sm" onClick={onEdit} title="Split, transfer or edit">
            <Icon name="edit" size={14} /> More
          </button>
          {categoryId && t.payee && (changed || !t.suggested_category_id) && (
            <label className="check small muted" style={{ flexBasis: '100%' }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Always put “{t.payee}” here
            </label>
          )}
        </div>
      )}
    </div>
  );
}
