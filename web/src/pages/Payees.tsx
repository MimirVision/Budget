/**
 * Mottakere: everyone the money goes to (or comes from), as one entry each. Give a payee a fixed category and every
 * purchase from them gets it, the old ones and the ones the bank sends later. Rename a payee to tidy the bank's
 * names ("KIWI 552 GULSET" → "Kiwi"); renaming to a name that's already there merges the two.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, undoPayeeCategory, type PayeeApplied, type PayeeRow } from '../api';
import { dayLabel } from '../format';
import { useStore } from '../store';
import { CategorySelect, Icon, Modal, Money, Skeleton, haptic, useToast } from '../components/ui';
import { Tile, nameTint } from '../components/apple';

type Filter = 'all' | 'none' | 'set';
const STEP = 60;

export default function PayeesPage() {
  const { summary, version, changed } = useStore();
  const toast = useToast();
  const [rows, setRows] = useState<PayeeRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(STEP);
  const [renaming, setRenaming] = useState<PayeeRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => api.get<PayeeRow[]>('/payees').then(setRows), []);
  useEffect(() => {
    load().catch((e) => toast(e.message, { error: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, version]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) =>
        (filter === 'all' || (filter === 'set') === !!r.category_id) &&
        (!q || r.payee.toLowerCase().includes(q) || r.aliases.some((a) => a.toLowerCase().includes(q))),
    );
  }, [rows, search, filter]);
  useEffect(() => setShown(STEP), [search, filter]);

  const setCategory = async (p: PayeeRow, categoryId: number | null) => {
    setBusy(p.payee);
    try {
      const r = await api.post<PayeeApplied>('/payees/category', { payee: p.payee, category_id: categoryId });
      haptic();
      const name = summary?.categories.find((c) => c.id === categoryId)?.name;
      toast(
        categoryId
          ? r.changed
            ? `${name} er satt på ${r.changed} kjøp fra ${p.payee}, og nye får den også`
            : `Nye fra ${p.payee} får ${name}`
          : `${p.payee} har ikke fast kategori lenger. Kjøpene beholder kategorien de har.`,
        {
          action: {
            label: 'Angre',
            run: async () => {
              await undoPayeeCategory(p.payee, r);
              changed();
            },
          },
        },
      );
      changed();
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(null);
    }
  };

  if (!summary) return null;
  const withoutCategory = (rows ?? []).filter((r) => !r.category_id).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mottakere</h1>
          <div className="sub">
            {rows ? `${rows.length} mottakere · ${withoutCategory} uten fast kategori` : 'Henter…'}
          </div>
        </div>
      </div>

      <p className="muted small payee-intro">
        Gi en mottaker en fast kategori, så får alle kjøp fra dem den, også de som kommer fra banken senere. Gi nytt navn for
        å rydde i bankens navn eller slå sammen to som er samme butikk.
      </p>

      <div className="row payee-tools">
        <div className="payee-search">
          <input className="input" placeholder="Søk etter mottaker" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Søk etter mottaker" />
          <Icon name="search" size={18} />
        </div>
        <div className="seg" role="group" aria-label="Vis">
          {(
            [
              ['all', 'Alle'],
              ['none', 'Uten kategori'],
              ['set', 'Med kategori'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!rows ? (
        <Skeleton rows={6} />
      ) : visible.length === 0 ? (
        <div className="card empty">
          <div className="emoji">🔎</div>
          {rows.length === 0 ? 'Ingen mottakere ennå. De dukker opp her når transaksjonene kommer inn.' : 'Ingen mottakere passer med søket.'}
        </div>
      ) : (
        <div className="card payee-list">
          {visible.slice(0, shown).map((p) => (
            <div key={p.payee} className={`payee-row ${busy === p.payee ? 'busy' : ''}`}>
              <Tile color={nameTint(p.payee)} letter={p.payee} size={34} />
              <div className="payee-name">
                <strong className="ellipsis">{p.payee}</strong>
                <span className="small muted ellipsis">
                  {p.count} {p.count === 1 ? 'transaksjon' : 'transaksjoner'} · sist {dayLabel(p.last)}
                </span>
                {p.aliases.length > 0 && (
                  <span className="small faint ellipsis" title={p.aliases.join(', ')}>
                    Også kalt {p.aliases.join(', ')}
                  </span>
                )}
              </div>
              <div className="payee-amount">
                {p.spent > 0 && <Money value={-p.spent} />}
                {p.received > 0 && <Money value={p.received} sign />}
              </div>
              <div className="payee-cat">
                <CategorySelect
                  categories={summary.categories}
                  value={p.category_id}
                  amount={p.spent >= p.received ? -1 : 1}
                  placeholder="Ingen fast kategori"
                  onChange={(id) => setCategory(p, id)}
                />
                {!p.category_id && p.usual_category_id && (
                  <button className="link-btn small" onClick={() => setCategory(p, p.usual_category_id)} disabled={busy === p.payee}>
                    Bruk {p.usual_category} for alle
                  </button>
                )}
              </div>
              <div className="payee-actions">
                <Link to={`/transactions?payee=${encodeURIComponent(p.payee)}`} className="btn ghost sm">
                  Se kjøp
                </Link>
                <button className="icon-btn" onClick={() => setRenaming(p)} aria-label={`Gi ${p.payee} nytt navn`} title="Gi nytt navn eller slå sammen">
                  <Icon name="edit" size={18} />
                </button>
              </div>
            </div>
          ))}
          {visible.length > shown && (
            <button className="btn ghost payee-more" onClick={() => setShown((n) => n + STEP)}>
              Vis flere ({visible.length - shown})
            </button>
          )}
        </div>
      )}

      {renaming && (
        <RenameDialog
          payee={renaming}
          all={rows ?? []}
          onClose={() => setRenaming(null)}
          onDone={(to, n) => {
            setRenaming(null);
            toast(`${renaming.payee} heter nå ${to}${n ? ` på ${n} ${n === 1 ? 'transaksjon' : 'transaksjoner'}` : ''}. Nye fra banken får også navnet.`);
            changed();
          }}
        />
      )}
    </>
  );
}

function RenameDialog({
  payee,
  all,
  onClose,
  onDone,
}: {
  payee: PayeeRow;
  all: PayeeRow[];
  onClose: () => void;
  onDone: (to: string, changed: number) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(payee.payee);
  const [saving, setSaving] = useState(false);
  const target = all.find((p) => p.payee.toLowerCase() === name.trim().toLowerCase() && p.payee !== payee.payee);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<{ changed: number }>('/payees/rename', { from: payee.payee, to: name.trim() });
      onDone(target?.payee ?? name.trim(), r.changed);
    } catch (e: any) {
      toast(e.message, { error: true });
      setSaving(false);
    }
  };
  return (
    <Modal
      title={`Gi ${payee.payee} nytt navn`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button className="btn primary" onClick={save} disabled={saving || !name.trim() || name.trim() === payee.payee}>
            {target ? `Slå sammen med ${target.payee}` : 'Lagre'}
          </button>
        </>
      }
    >
      <label className="field">
        Nytt navn
        <input
          className="input"
          value={name}
          autoFocus
          list="payee-names"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && name.trim() !== payee.payee && save()}
        />
        <datalist id="payee-names">
          {all
            .filter((p) => p.payee !== payee.payee)
            .slice(0, 200)
            .map((p) => (
              <option key={p.payee} value={p.payee} />
            ))}
        </datalist>
      </label>
      {target ? (
        <div className="callout info small">
          <Icon name="split" size={18} />
          <div>
            {target.payee} finnes fra før. De {payee.count} transaksjonene flyttes dit, så det blir én mottaker med {payee.count + target.count}.
            {target.category_id || payee.category_id ? ' Den faste kategorien blir med.' : ''}
          </div>
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          Endrer navnet på alle {payee.count} transaksjonene. Når banken sender «{payee.payee}» igjen, får den det nye navnet.
        </p>
      )}
    </Modal>
  );
}
