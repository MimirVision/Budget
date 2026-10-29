import { useState } from 'react';
import { api, type Split, type Transaction } from '../api';
import { kr } from '../format';
import { useStore } from '../store';
import { CategorySelect, Icon, Modal, MoneyInput, useToast } from './ui';
import { todayISO } from '../../../shared/months';

type Mode = 'category' | 'split' | 'transfer';

/** Add or edit a transaction. Handles a single category, splits across several, or a transfer between accounts. */
export function TransactionEditor({
  txn,
  defaultAccountId,
  onClose,
  onSaved,
}: {
  txn?: Transaction;
  defaultAccountId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { summary, refresh } = useStore();
  const toast = useToast();
  const accounts = summary?.accounts.filter((a) => !a.closed) ?? [];
  const categories = summary?.categories ?? [];
  const isNew = !txn;

  const [accountId, setAccountId] = useState<number>(txn?.account_id ?? defaultAccountId ?? accounts[0]?.id);
  const [date, setDate] = useState(txn?.date ?? todayISO());
  const [direction, setDirection] = useState<'out' | 'in'>(txn && txn.amount > 0 ? 'in' : 'out');
  const [amount, setAmount] = useState(Math.abs(txn?.amount ?? 0));
  const [payee, setPayee] = useState(txn?.payee ?? '');
  const [memo, setMemo] = useState(txn?.memo ?? '');
  const [categoryId, setCategoryId] = useState<number | null>(txn?.category_id ?? txn?.suggested_category_id ?? null);
  const [mode, setMode] = useState<Mode>(txn?.transfer_id ? 'transfer' : txn?.splits.length ? 'split' : 'category');
  const [transferAccount, setTransferAccount] = useState<number | null>(txn?.transfer_account_id ?? txn?.suggested_transfer_account_id ?? null);
  const [splits, setSplits] = useState<Split[]>(
    txn?.splits.length
      ? txn.splits.map((s) => ({ ...s, amount: Math.abs(s.amount) }))
      : [
          { category_id: txn?.category_id ?? txn?.suggested_category_id ?? null, amount: Math.abs(txn?.amount ?? 0), memo: '' },
          { category_id: null, amount: 0, memo: '' },
        ],
  );
  const [remember, setRemember] = useState(false);
  const [saving, setSaving] = useState(false);

  const signed = direction === 'out' ? -amount : amount;
  const splitTotal = splits.reduce((s, x) => s + x.amount, 0);
  const splitLeft = amount - splitTotal;

  const save = async () => {
    setSaving(true);
    try {
      const body: any = { account_id: accountId, date, amount: signed, payee: payee.trim(), memo };
      if (mode === 'category') {
        body.category_id = categoryId;
        body.splits = [];
        body.remember = remember;
        if (txn?.transfer_id) body.transfer_account_id = null;
      } else if (mode === 'split') {
        if (splitLeft !== 0) throw new Error(`The splits are ${kr(Math.abs(splitLeft))} ${splitLeft > 0 ? 'short' : 'over'}`);
        body.splits = splits.filter((s) => s.amount).map((s) => ({ ...s, amount: direction === 'out' ? -s.amount : s.amount }));
        if (txn?.transfer_id) body.transfer_account_id = null;
      } else {
        if (!transferAccount) throw new Error('Pick the other account');
        if (txn?.suggested_transfer_id && transferAccount === txn.suggested_transfer_account_id) body.transfer_id = txn.suggested_transfer_id;
        else if (transferAccount !== txn?.transfer_account_id) body.transfer_account_id = transferAccount;
      }
      if (isNew) {
        await api.post('/transactions', {
          ...body,
          category_id: mode === 'category' ? categoryId : null,
          transfer_account_id: mode === 'transfer' ? transferAccount : undefined,
        });
      } else {
        await api.patch(`/transactions/${txn!.id}`, { ...body, reviewed: true });
      }
      await refresh();
      onSaved();
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!txn || !confirm('Delete this transaction?')) return;
    await api.del(`/transactions/${txn.id}`);
    await refresh();
    onSaved();
  };

  return (
    <Modal
      title={isNew ? 'Add transaction' : 'Edit transaction'}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={remove}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || !amount} onClick={save}>
            {isNew ? 'Add' : 'Save'}
          </button>
        </>
      }
    >
      <div className="seg">
        <button className={direction === 'out' ? 'on' : ''} onClick={() => setDirection('out')}>
          Money out
        </button>
        <button className={direction === 'in' ? 'on' : ''} onClick={() => setDirection('in')}>
          Money in
        </button>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>
          Amount
          <MoneyInput value={amount} onCommit={setAmount} autoFocus={isNew} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>
          Date
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          Payee
          <input className="input" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. Rema 1000" />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          Account
          <select className="select" value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {txn?.raw_description && txn.raw_description !== txn.payee && (
        <div className="small faint">Bank text: {txn.raw_description}</div>
      )}

      <div className="seg">
        <button className={mode === 'category' ? 'on' : ''} onClick={() => setMode('category')}>
          Category
        </button>
        <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>
          <Icon name="split" size={14} /> Split
        </button>
        <button className={mode === 'transfer' ? 'on' : ''} onClick={() => setMode('transfer')}>
          <Icon name="swap" size={14} /> Transfer
        </button>
      </div>

      {mode === 'category' && (
        <>
          <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} amount={signed} />
          {payee.trim() && categoryId && (
            <label className="check small">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Always use this category for “{payee.trim()}”
            </label>
          )}
        </>
      )}

      {mode === 'split' && (
        <div className="stack" style={{ gap: 8 }}>
          {splits.map((s, i) => (
            <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
              <CategorySelect
                categories={categories}
                value={s.category_id}
                amount={signed}
                onChange={(id) => setSplits(splits.map((x, j) => (j === i ? { ...x, category_id: id } : x)))}
              />
              <div style={{ width: 130, flex: 'none' }}>
                <MoneyInput value={s.amount} onCommit={(v) => setSplits(splits.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
              </div>
              <button className="icon-btn" aria-label="Remove split" onClick={() => setSplits(splits.filter((_, j) => j !== i))}>
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
          <div className="row">
            <button className="btn sm" onClick={() => setSplits([...splits, { category_id: null, amount: Math.max(0, splitLeft), memo: '' }])}>
              <Icon name="plus" size={14} /> Add split
            </button>
            <span className="spacer" />
            <span className={`small ${splitLeft === 0 ? 'muted' : ''}`} style={{ color: splitLeft !== 0 ? 'var(--warn)' : undefined }}>
              {splitLeft === 0 ? 'All assigned ✓' : `${kr(Math.abs(splitLeft))} ${splitLeft > 0 ? 'left to split' : 'too much'}`}
            </span>
          </div>
        </div>
      )}

      {mode === 'transfer' && (
        <>
          <label className="field">
            {direction === 'out' ? 'Money went to' : 'Money came from'}
            <select className="select" value={transferAccount ?? ''} onChange={(e) => setTransferAccount(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Choose account…</option>
              {accounts
                .filter((a) => a.id !== accountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="small muted">
            Transfers between your own accounts (paying the credit card, topping up Revolut, moving to savings) aren't spending, so they
            don't touch your budget.
          </div>
        </>
      )}

      <label className="field">
        Note
        <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
      </label>
    </Modal>
  );
}
