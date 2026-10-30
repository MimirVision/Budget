import { useEffect, useRef, useState } from 'react';
import { api, type Attachment, type Split, type Transaction } from '../api';
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
        if (splitLeft !== 0) throw new Error(`Delbeløpene er ${kr(Math.abs(splitLeft))} ${splitLeft > 0 ? 'for lite' : 'for mye'}`);
        body.splits = splits.filter((s) => s.amount).map((s) => ({ ...s, amount: direction === 'out' ? -s.amount : s.amount }));
        if (txn?.transfer_id) body.transfer_account_id = null;
      } else {
        if (!transferAccount) throw new Error('Velg den andre kontoen');
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
    if (!txn || !confirm('Slette denne transaksjonen?')) return;
    await api.del(`/transactions/${txn.id}`);
    await refresh();
    onSaved();
  };

  return (
    <Modal
      title={isNew ? 'Ny transaksjon' : 'Endre transaksjon'}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={remove}>
              <Icon name="trash" size={16} /> Slett
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button className="btn primary" disabled={saving || !amount} onClick={save}>
            {isNew ? 'Legg til' : 'Lagre'}
          </button>
        </>
      }
    >
      <div className="seg">
        <button className={direction === 'out' ? 'on' : ''} onClick={() => setDirection('out')}>
          Penger ut
        </button>
        <button className={direction === 'in' ? 'on' : ''} onClick={() => setDirection('in')}>
          Penger inn
        </button>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>
          Beløp
          <MoneyInput value={amount} onCommit={setAmount} autoFocus={isNew} />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 140 }}>
          Dato
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          Mottaker
          <input className="input" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="f.eks. Rema 1000" />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          Konto
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
        <div className="small faint">Banktekst: {txn.raw_description}</div>
      )}

      <div className="seg">
        <button className={mode === 'category' ? 'on' : ''} onClick={() => setMode('category')}>
          Kategori
        </button>
        <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>
          <Icon name="split" size={14} /> Del opp
        </button>
        <button className={mode === 'transfer' ? 'on' : ''} onClick={() => setMode('transfer')}>
          <Icon name="swap" size={14} /> Overføring
        </button>
      </div>

      {mode === 'category' && (
        <>
          <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} amount={signed} />
          {payee.trim() && categoryId && (
            <label className="check small">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Bruk alltid denne kategorien for «{payee.trim()}»
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
              <button className="icon-btn" aria-label="Fjern del" onClick={() => setSplits(splits.filter((_, j) => j !== i))}>
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
          <div className="row">
            <button className="btn sm" onClick={() => setSplits([...splits, { category_id: null, amount: Math.max(0, splitLeft), memo: '' }])}>
              <Icon name="plus" size={14} /> Legg til del
            </button>
            <span className="spacer" />
            <span className={`small ${splitLeft === 0 ? 'muted' : ''}`} style={{ color: splitLeft !== 0 ? 'var(--warn)' : undefined }}>
              {splitLeft === 0 ? 'Alt er fordelt ✓' : `${kr(Math.abs(splitLeft))} ${splitLeft > 0 ? 'igjen å fordele' : 'for mye'}`}
            </span>
          </div>
        </div>
      )}

      {mode === 'transfer' && (
        <>
          <label className="field">
            {direction === 'out' ? 'Pengene gikk til' : 'Pengene kom fra'}
            <select className="select" value={transferAccount ?? ''} onChange={(e) => setTransferAccount(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Velg konto…</option>
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
            Overføringer mellom egne kontoer (betale kredittkortet, fylle på Revolut, flytte til sparing) er ikke forbruk, så de
            påvirker ikke budsjettet.
          </div>
        </>
      )}

      <label className="field">
        Notat
        <textarea
          className="input note-input"
          rows={2}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="F.eks. hva det var, hvem det gjaldt, garanti til 2028"
        />
      </label>
      {txn ? (
        <Attachments txnId={txn.id} />
      ) : (
        <p className="muted small-print">Du kan legge ved kvittering når transaksjonen er lagret.</p>
      )}
    </Modal>
  );
}

/** Shrinks photos so they fit comfortably (receipts stay readable at 1600 px). PDFs and small files pass through. */
async function prepare(file: File): Promise<{ blob: Blob; name: string }> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 400_000) return { blob: file, name: file.name };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    if (!blob) return { blob: file, name: file.name };
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
  } catch {
    return { blob: file, name: file.name };
  }
}

function sizeLabel(bytes: number) {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} kB` : `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

function Attachments({ txnId }: { txnId: number }) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    api.get<Attachment[]>(`/transactions/${txnId}/attachments`).then(setItems).catch(() => setItems([]));
  }, [txnId]);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const { blob, name } = await prepare(f);
        const a = await api.upload<Attachment>(`/transactions/${txnId}/attachments`, blob, name);
        setItems((xs) => [...(xs ?? []), a]);
      }
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async (a: Attachment) => {
    if (!confirm(`Fjerne ${a.name}?`)) return;
    await api.del(`/attachments/${a.id}`);
    setItems((xs) => (xs ?? []).filter((x) => x.id !== a.id));
  };

  return (
    <div className="field">
      Vedlegg
      <div className="attachments">
        {items?.map((a) => (
          <div key={a.id} className="attachment">
            <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="attachment-link">
              {a.mime.startsWith('image/') ? (
                <img src={`/api/attachments/${a.id}`} alt="" loading="lazy" />
              ) : (
                <span className="attachment-icon">PDF</span>
              )}
              <span className="attachment-meta">
                <span className="attachment-name">{a.name}</span>
                <span className="muted">{sizeLabel(a.size)}</span>
              </span>
            </a>
            <button className="icon-btn" onClick={() => remove(a)} aria-label={`Fjern ${a.name}`}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        ))}
        <button className="btn sm" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="clip" size={16} /> {busy ? 'Laster opp …' : 'Legg ved kvittering'}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*,application/pdf"
          multiple
          hidden
          onChange={(e) => add(e.target.files)}
        />
      </div>
    </div>
  );
}
