import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Transaction } from '../api';
import { dayLabel, kr } from '../format';
import { useStore } from '../store';
import { CategorySelect, Icon, Money, Skeleton, haptic, useToast } from '../components/ui';
import { useIsMobile } from '../hooks';
import { SyncNow } from '../components/controls';
import { TransactionEditor } from '../components/TransactionEditor';

const SOURCE_LABEL: Record<string, string> = {
  rule: 'din regel',
  history: 'som sist',
  merchant: 'kjent mottaker',
};

/** The inbox: every new transaction, from any source, shows up here once with a suggested category. */
export default function ReviewPage() {
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [startCount, setStartCount] = useState<number | null>(null);
  const { summary, refresh, version } = useStore();
  const mobile = useIsMobile();
  const toast = useToast();
  // PC: the card you're on, moved with ↑/↓ (or J/K); the card itself handles Enter, E and 1–5.
  const [focus, setFocus] = useState(0);

  const load = useCallback(async () => {
    const r = await api.get<{ transactions: Transaction[] }>('/transactions?review=1&limit=500');
    setItems(r.transactions);
    setStartCount((n) => (n === null ? r.transactions.length : Math.max(n, r.transactions.length)));
  }, []);
  useEffect(() => {
    load();
  }, [load, version]);

  const after = async () => {
    await Promise.all([load(), refresh()]);
  };

  const undo = (id: number) => ({
    label: 'Angre',
    run: async () => {
      await api.patch(`/transactions/${id}`, { reviewed: false });
      await after();
    },
  });

  const approve = async (t: Transaction, categoryId: number | null, remember: boolean) => {
    // Optimistically hide it so the list feels instant.
    setItems((list) => list?.filter((x) => x.id !== t.id) ?? null);
    haptic();
    await api.patch(`/transactions/${t.id}`, categoryId ? { category_id: categoryId, remember } : { reviewed: true });
    const cat = summary?.categories.find((c) => c.id === categoryId);
    toast(cat ? `${t.payee} → ${cat.name}${remember ? ' (huskes)' : ''}` : `${t.payee} godkjent`, { action: undo(t.id) });
    await after();
  };

  const confirmTransfer = async (t: Transaction) => {
    setItems((list) => list?.filter((x) => x.id !== t.id && x.id !== t.suggested_transfer_id) ?? null);
    haptic();
    await api.patch(`/transactions/${t.id}`, { transfer_id: t.suggested_transfer_id });
    toast(`Markert som overføring ${t.amount < 0 ? 'til' : 'fra'} ${t.suggested_transfer_account_name}`, {
      action: {
        label: 'Angre',
        run: async () => {
          await api.patch(`/transactions/${t.id}`, { transfer_account_id: null, restore_suggestion: true });
          await after();
        },
      },
    });
    await after();
  };

  const rejectTransfer = async (t: Transaction) => {
    // Forget the transfer guess (on the server too, so it doesn't come back) and fall back to categorising.
    setItems((list) => list?.map((x) => (x.id === t.id ? { ...x, suggested_transfer_id: null, suggested_transfer_account_name: null } : x)) ?? null);
    await api.patch(`/transactions/${t.id}`, { reject_transfer: true });
  };

  const approveAll = async () => {
    // The server approves in batches; keep asking until it's done.
    let approved = 0;
    for (let more = true; more; ) {
      const r = await api.post<{ approved: number; more: boolean }>('/transactions/approve');
      approved += r.approved;
      more = r.more && r.approved > 0;
    }
    haptic(25);
    toast(`Godkjente ${approved} ${approved === 1 ? 'transaksjon' : 'transaksjoner'}`);
    await after();
  };

  useEffect(() => {
    if (mobile) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, .modal-back, .palette-back') || e.ctrlKey || e.metaKey || e.altKey) return;
      const n = items?.length ?? 0;
      if (e.key === 'ArrowDown' || e.key === 'j') (e.preventDefault(), setFocus((f) => Math.min(n - 1, f + 1)));
      if (e.key === 'ArrowUp' || e.key === 'k') (e.preventDefault(), setFocus((f) => Math.max(0, f - 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobile, items?.length]);
  // Stay on the same spot when the card you were on is approved and leaves the list.
  useEffect(() => {
    if (items && focus > items.length - 1) setFocus(Math.max(0, items.length - 1));
  }, [items, focus]);

  if (!items || !summary) return <Skeleton rows={6} />;
  const done = startCount ? startCount - items.length : 0;
  const withSuggestion = items.filter((t) => t.suggested_category_id || (t.suggested_transfer_id && t.suggested_transfer_account_name)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gjennomgå</h1>
          <div className="sub">
            {items.length ? `${items.length} ${items.length === 1 ? 'ny transaksjon' : 'nye transaksjoner'} fra bankene og importer` : 'Alt er gjennomgått'}
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
        <SyncNow compact />
        {withSuggestion > 0 && (
          <button className="btn primary" onClick={approveAll}>
            <Icon name="check" size={16} /> {mobile ? `Godkjenn ${withSuggestion}` : `Godkjenn ${withSuggestion} forslag`}
          </button>
        )}
        </div>
      </div>

      {startCount !== null && startCount > 0 && items.length > 0 && (
        <>
          <div className="review-progress" aria-label={`${done} av ${startCount} gjennomgått`}>
            <div style={{ width: `${(done / startCount) * 100}%` }} />
          </div>
          {mobile ? (
            <div className="swipe-hint">Sveip til høyre for å godkjenne →</div>
          ) : (
            <div className="swipe-hint keys-hint">
              <kbd>↑</kbd> <kbd>↓</kbd> flytt · <kbd>Enter</kbd> godkjenn · <kbd>1</kbd>–<kbd>5</kbd> mest brukte kategorier · <kbd>E</kbd> endre ·{' '}
              <kbd>T</kbd>/<kbd>N</kbd> overføring ja/nei
            </div>
          )}
        </>
      )}

      {items.length === 0 ? (
        <div className="card empty">
          <div className="emoji celebrate">🎉</div>
          <h2 style={{ color: 'var(--text)' }}>Alt er gjennomgått</h2>
          <p>Nye transaksjoner dukker opp her når bankene synkroniseres eller du importerer en fil.</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link to="/" className="btn">
              Tilbake til budsjettet
            </Link>
            <Link to="/accounts" className="btn ghost">
              Synkroniser eller importer
            </Link>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {items.map((t, i) => (
            <ReviewCard
              key={t.id}
              t={t}
              focused={!mobile && i === focus}
              onFocusMe={() => setFocus(i)}
              onApprove={approve}
              onTransfer={confirmTransfer}
              onRejectTransfer={rejectTransfer}
              onEdit={() => setEditing(t)}
              swipe={mobile}
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
  swipe,
  focused,
  onFocusMe,
}: {
  t: Transaction;
  swipe?: boolean;
  focused?: boolean;
  onFocusMe?: () => void;
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
  const canSwipe = swipe && (transferGuess || categoryId);
  const [dx, setDx] = useState(0);
  const [gone, setGone] = useState(false);
  const startX = useRef<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // The five categories you use most, for the number keys.
  const top = (summary?.categories ?? [])
    .filter((c) => !c.hidden && (c.uses ?? 0) > 0 && !!c.is_income === t.amount > 0)
    .sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0))
    .slice(0, 5);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, .modal-back, .palette-back') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (transferGuess) {
        if (e.key === 't' || e.key === 'Enter') (e.preventDefault(), onTransfer(t));
        if (e.key === 'n') (e.preventDefault(), onRejectTransfer(t));
      } else {
        if (e.key === 'Enter' && categoryId) (e.preventDefault(), onApprove(t, categoryId, remember));
        const n = Number(e.key);
        if (n >= 1 && n <= top.length) (e.preventDefault(), setCategoryId(top[n - 1].id));
      }
      if (e.key === 'e') (e.preventDefault(), onEdit());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Swipe right to approve: the satisfying way to clear the inbox on a phone.
  const onDown = (e: React.PointerEvent) => {
    if (!canSwipe || (e.target as HTMLElement).closest('select, button, input, label')) return;
    startX.current = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (startX.current === null) return;
    setDx(Math.max(0, e.clientX - startX.current));
  };
  const onUp = () => {
    if (startX.current === null) return;
    startX.current = null;
    if (dx > 110) {
      setGone(true);
      setTimeout(() => (transferGuess ? onTransfer(t) : onApprove(t, categoryId, remember)), 180);
    } else setDx(0);
  };

  const card = (
    <div
      ref={ref}
      className={`card review-card ${canSwipe ? 'swipe-card' : ''} ${startX.current !== null ? 'dragging' : ''} ${gone ? 'gone' : ''} ${focused ? 'kb-focus' : ''}`}
      onMouseDown={onFocusMe}
      style={canSwipe ? { transform: `translateX(${dx}px)` } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div style={{ minWidth: 0 }}>
        <div className="payee ellipsis">{t.payee || t.raw_description || 'Ukjent'}</div>
        <div className="small muted">
          {dayLabel(t.date)} · {t.account_name}
          {t.suggested_category_name && !changed && (
            <>
              {' · '}
              <span className="chip brand">✨ {t.suggestion_source === 'merchant' && t.amount > 0 ? 'ser ut som lønn' : SOURCE_LABEL[t.suggestion_source ?? ''] ?? 'forslag'}</span>
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
              Ser ut som {kr(Math.abs(t.amount))} ble flyttet {t.amount < 0 ? 'til' : 'fra'} <strong>{t.suggested_transfer_account_name}</strong>
              {t.suggested_transfer_date ? ` (${dayLabel(t.suggested_transfer_date)})` : ''}. Overføringer er ikke forbruk.
            </div>
          </div>
          <button className="btn primary" onClick={() => onTransfer(t)}>
            Ja, overføring
          </button>
          <button className="btn ghost" onClick={() => onRejectTransfer(t)}>
            Nei
          </button>
        </div>
      ) : (
        <div className="actions">
          <CategorySelect categories={summary?.categories ?? []} value={categoryId} onChange={setCategoryId} amount={t.amount} />
          {focused && top.length > 0 && (
            <div className="kb-cats small" style={{ flexBasis: '100%' }}>
              {top.map((c, n) => (
                <button key={c.id} className={`chip-btn ${categoryId === c.id ? 'on' : ''}`} onClick={() => setCategoryId(c.id)}>
                  <kbd>{n + 1}</kbd> {c.name}
                </button>
              ))}
            </div>
          )}
          <button className="btn primary rv-approve" disabled={!categoryId} onClick={() => onApprove(t, categoryId, remember)} aria-label="Godkjenn">
            <Icon name="check" size={16} /> <span className="hide-phone">Godkjenn</span>
          </button>
          <button className="btn ghost sm rv-more" onClick={onEdit} title="Del opp, overfør eller endre" aria-label="Mer: del opp, overfør eller endre">
            <Icon name="edit" size={14} /> <span className="hide-phone">Mer</span>
          </button>
          {categoryId && t.payee && (changed || !t.suggested_category_id) && (
            <label className="check small muted" style={{ flexBasis: '100%' }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Legg alltid «{t.payee}» her
            </label>
          )}
        </div>
      )}
    </div>
  );
  if (!canSwipe) return card;
  return (
    <div className="swipe-wrap">
      <div className="swipe-bg" style={{ opacity: Math.min(1, dx / 110) }}>
        <Icon name="check" size={20} /> {transferGuess ? 'Overføring' : 'Godkjenn'}
      </div>
      {card}
    </div>
  );
}
