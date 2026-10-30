/**
 * Duplikater: transactions registered more than once, grouped with a plain explanation of why, and a one-tap merge.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { dayLabel, kr } from '../format';
import { useStore } from '../store';
import { Icon, Money, Skeleton, haptic, useToast } from '../components/ui';

interface Row {
  id: number;
  date: string;
  amount: number;
  payee: string;
  raw_description: string;
  source: string;
  account_name: string;
  category_name: string | null;
  reviewed: number;
  transfer_id: number | null;
  memo: string;
}
interface Group {
  key: string;
  reason: 'csv_and_sync' | 'transfer_copy' | 'manual_and_bank' | 'bank_changed_id' | 'two_bank_routes' | 'same_day_same_text' | 'other';
  confidence: 'sure' | 'maybe';
  keep: number;
  rows: Row[];
}
interface Data {
  groups: Group[];
  accounts: Array<{ a: { id: number; name: string }; b: { id: number; name: string }; shared: number }>;
}

const REASONS: Record<Group['reason'], string> = {
  csv_and_sync: 'Kom både fra en CSV-fil og fra banksynken. Kortkjøp har ofte kjøpsdato i filen og bokføringsdato i synken.',
  transfer_copy: 'Appen laget motposten da du merket en overføring, og så sendte banken den samme transaksjonen.',
  manual_and_bank: 'Lagt inn for hånd, og så kom den samme fra banken med litt annen dato.',
  bank_changed_id: 'Banken sendte samme kjøp to ganger med ulik ID, typisk når et reservert kjøp blir bokført.',
  two_bank_routes:
    'Kontoen hentes fra to bankkoblinger (for eksempel både SpareBank 1 og Enable Banking), så hver transaksjon kommer to ganger. Koble kontoen fra den ene under Kontoer.',
  same_day_same_text: 'Samme beløp, dag og tekst. Kan være samme kjøp to ganger, eller to like kjøp (to kaffer).',
  other: 'Samme beløp på samme konto med få dagers mellomrom.',
};

const SOURCES: Record<string, string> = {
  enablebanking: 'Banksynk',
  sparebank1: 'SpareBank 1-synk',
  csv: 'CSV-import',
  manual: 'Lagt inn for hånd',
  transfer: 'Laget av overføring',
};

export default function DuplicatesPage() {
  const [data, setData] = useState<Data | null>(null);
  const [keep, setKeep] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const { refresh, changed } = useStore();
  const toast = useToast();

  const load = () => api.get<Data>('/duplicates').then(setData);
  useEffect(() => {
    load();
  }, []);

  if (!data) return <Skeleton rows={6} />;
  const sure = data.groups.filter((g) => g.confidence === 'sure');

  const merge = async (g: Group) => {
    const k = keep[g.key] ?? g.keep;
    await api.post('/duplicates/merge', { keep: k, remove: g.rows.map((r) => r.id).filter((id) => id !== k) });
  };
  const done = async () => {
    await load();
    await refresh();
    changed();
  };
  const mergeOne = async (g: Group) => {
    setBusy(g.key);
    try {
      await merge(g);
      haptic();
      toast(`Slo sammen ${g.rows.length} like transaksjoner`);
      await done();
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(null);
    }
  };
  const mergeAllSure = async () => {
    if (!confirm(`Slå sammen ${sure.length} grupper som helt sikkert er duplikater?`)) return;
    setBusy('all');
    try {
      for (const g of sure) await merge(g);
      haptic();
      toast(`Ryddet ${sure.length} duplikater`);
      await done();
    } catch (e: any) {
      toast(e.message, { error: true });
      await done();
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (g: Group) => {
    await api.post('/duplicates/dismiss', { key: g.key });
    toast('Merket som ikke duplikat');
    await load();
  };

  return (
    <div className="dup-page">
      <div className="page-head">
        <div>
          <Link to="/transactions" className="small muted desktop-only">
            ← Transaksjoner
          </Link>
          <h1>Duplikater</h1>
          <p className="muted page-desc" style={{ margin: 0 }}>
            Transaksjoner som er registrert mer enn én gang. Det du har gjort med en kopi (kategori, notat, kvittering,
            overføring) blir med over når de slås sammen.
          </p>
        </div>
        {sure.length > 1 && (
          <button className="btn primary" disabled={!!busy} onClick={mergeAllSure}>
            Slå sammen alle sikre ({sure.length})
          </button>
        )}
      </div>

      {data.accounts.map((p) => (
        <div key={`${p.a.id}-${p.b.id}`} className="callout bad" style={{ marginBottom: 12 }}>
          <Icon name="alert" size={18} />
          <div>
            <strong>
              {p.a.name} og {p.b.name}
            </strong>{' '}
            har {p.shared} like transaksjoner de siste 90 dagene. Det ser ut som samme bankkonto er koblet til to ganger,
            for eksempel både via SpareBank 1 og Enable Banking. Slå dem sammen eller koble fra den ene under{' '}
            <Link to="/accounts">Kontoer</Link>.
          </div>
        </div>
      ))}

      {data.groups.length === 0 ? (
        <div className="card empty">
          <div className="emoji">✨</div>
          Ingen duplikater funnet.
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {data.groups.map((g) => {
            const k = keep[g.key] ?? g.keep;
            return (
              <section key={g.key} className={`card dup-group ${g.confidence}`}>
                <div className="dup-head">
                  <span className={`chip ${g.confidence === 'sure' ? 'brand' : ''}`}>
                    {g.confidence === 'sure' ? 'Duplikat' : 'Kanskje duplikat'} · {g.rows.length} stk
                  </span>
                  <strong>
                    <Money value={g.rows[0].amount} sign />
                  </strong>
                </div>
                <p className="small muted dup-why">{REASONS[g.reason]}</p>
                <div className="dup-rows">
                  {g.rows.map((r) => (
                    <label key={r.id} className={`dup-row ${k === r.id ? 'on' : ''}`}>
                      <input type="radio" name={g.key} checked={k === r.id} onChange={() => setKeep({ ...keep, [g.key]: r.id })} />
                      <span className="dup-main">
                        <span className="ellipsis" style={{ fontWeight: 600 }}>
                          {r.payee || r.raw_description}
                        </span>
                        <span className="small muted ellipsis">
                          {dayLabel(r.date)} · {r.account_name} · {SOURCES[r.source] ?? r.source}
                        </span>
                        <span className="small faint ellipsis">
                          {r.transfer_id ? 'Overføring' : r.category_name ?? 'Uten kategori'}
                          {r.memo ? ` · ${r.memo}` : ''}
                          {r.raw_description && r.raw_description !== r.payee ? ` · «${r.raw_description}»` : ''}
                        </span>
                      </span>
                      <span className="small">{k === r.id ? 'Beholdes' : 'Fjernes'}</span>
                    </label>
                  ))}
                </div>
                <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn ghost sm" disabled={!!busy} onClick={() => dismiss(g)}>
                    Ikke duplikat
                  </button>
                  <button className="btn primary sm" disabled={!!busy} onClick={() => mergeOne(g)}>
                    {busy === g.key ? 'Slår sammen …' : `Behold én, fjern ${g.rows.length - 1}`}
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}
      <p className="small faint" style={{ marginTop: 16 }}>
        Sjekker det siste året. Totalt {kr(data.groups.reduce((s, g) => s + Math.abs(g.rows[0].amount) * (g.rows.length - 1), 0))} er
        registrert for mye.
      </p>
    </div>
  );
}
