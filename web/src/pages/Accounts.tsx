import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Account, type IngestResult } from '../api';
import { dayLabel, kr, timeAgo } from '../format';
import { useStore } from '../store';
import { Icon, Modal, Money, MoneyInput, useToast } from '../components/ui';

interface Connection {
  id: number;
  provider: string;
  providerLabel: string;
  name: string;
  status: 'pending' | 'linking' | 'active' | 'expired' | 'error';
  bankId: string | null;
  expires_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  discovered: Array<{ remoteId: string; name: string; iban?: string; kind?: string; balance?: number }>;
  accounts: Array<{ remote_id: string; remote_name: string; account_id: number | null; account_name: string | null }>;
}

const KIND_LABEL: Record<string, string> = {
  checking: 'Brukskonto',
  savings: 'Sparekonto',
  credit: 'Kredittkort',
  cash: 'Kontanter',
  loan: 'Lån / boliglån',
};

function describeResult(r: IngestResult) {
  const parts = [`${r.added} nye`];
  if (r.duplicates) parts.push(`${r.duplicates} fantes fra før`);
  if (r.matched) parts.push(`${r.matched} koblet til manuelle føringer`);
  if (r.transfers) parts.push(`${r.transfers} ${r.transfers === 1 ? 'overføring' : 'overføringer'} funnet`);
  return parts.join(' · ');
}

export default function AccountsPage() {
  const { summary, refresh } = useStore();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [importInto, setImportInto] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [syncing, setSyncing] = useState<number | 'all' | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  const loadConnections = useCallback(() => api.get<Connection[]>('/connections').then(setConnections), []);
  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  // Results of the BankID redirect.
  const bankError = params.get('bankError');
  const linkId = Number(params.get('link')) || null;
  const syncedId = params.get('synced');
  useEffect(() => {
    if (syncedId) {
      toast('Banken er koblet til og synkronisert. Nye transaksjoner venter under Gjennomgå.', { action: { label: 'Gjennomgå', run: () => navigate('/review') } });
      setParams({});
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedId]);
  const linking = connections.find((c) => c.id === linkId);

  const sync = async (id: number | 'all') => {
    setSyncing(id);
    try {
      if (id === 'all') {
        const r = await api.post<Array<{ name: string; added?: number; error?: string }>>('/connections/sync-all');
        const added = r.reduce((s, x) => s + (x.added ?? 0), 0);
        const failed = r.filter((x) => x.error);
        toast(failed.length ? `${failed.map((f) => `${f.name}: ${f.error}`).join('; ')}` : `Synkronisert. ${added} ${added === 1 ? 'ny transaksjon' : 'nye transaksjoner'}.`, {
          error: failed.length > 0,
        });
      } else {
        const r = await api.post<IngestResult>(`/connections/${id}/sync`);
        toast(`Synkronisert: ${describeResult(r)}`, r.errors?.length ? { error: true } : undefined);
      }
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setSyncing(null);
      await Promise.all([loadConnections(), refresh()]);
    }
  };

  const reconnect = async (c: Connection) => {
    try {
      const bankId = c.provider === 'enablebanking' ? c.bankId ?? c.name : undefined;
      const { url } = await api.post<{ url: string }>('/connections/start', { provider: c.provider, bankId, reconnectId: c.id });
      window.location.href = url;
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };

  if (!summary) return null;
  const open = summary.accounts.filter((a) => !a.closed);
  const closed = summary.accounts.filter((a) => a.closed);
  const budgetTotal = open.filter((a) => a.on_budget).reduce((s, a) => s + a.balance, 0);
  const netWorth = open.reduce((s, a) => s + a.balance, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Kontoer</h1>
          <div className="sub">
            I budsjettet <Money value={budgetTotal} /> · Formue <Money value={netWorth} />
          </div>
        </div>
        <div className="row">
          {connections.some((c) => c.status === 'active') && (
            <button className="btn" onClick={() => sync('all')} disabled={syncing !== null}>
              <Icon name="sync" size={16} /> {syncing === 'all' ? 'Synkroniserer…' : 'Synkroniser alle'}
            </button>
          )}
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Legg til konto
          </button>
        </div>
      </div>

      {bankError && (
        <div className="callout bad small" style={{ marginBottom: 14 }}>
          <Icon name="alert" size={18} />
          <div style={{ flex: 1 }}>Bankkoblingen ble ikke fullført: {bankError}</div>
          <button className="icon-btn" onClick={() => setParams({})} aria-label="Lukk">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {open.length === 0 && (
        <div className="card empty" style={{ marginBottom: 16 }}>
          <div className="emoji">🏦</div>
          <h2 style={{ color: 'var(--text)' }}>Legg til din første konto</h2>
          <p>Koble til med BankID, importer en CSV-fil fra nettbanken, eller skriv inn saldoen. Hver konto kan bruke sin egen metode.</p>
          <button className="btn primary" onClick={() => setAdding(true)}>
            Legg til konto
          </button>
        </div>
      )}

      {[
        { title: 'Budsjettkontoer', sub: 'Pengene dere bruker av: brukskonto, Revolut, kredittkort', items: open.filter((a) => a.on_budget) },
        { title: 'Oppfølgingskontoer', sub: 'Boliglån, sparing og investeringer dere følger med på, men ikke budsjetterer fra', items: open.filter((a) => !a.on_budget) },
        { title: 'Avsluttet', sub: '', items: closed },
      ]
        .filter((g) => g.items.length)
        .map((g) => (
          <section key={g.title} style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 16, margin: '0 0 2px' }}>{g.title}</h2>
            {g.sub && <div className="small muted" style={{ marginBottom: 8 }}>{g.sub}</div>}
            <div className="card list">
              {g.items.map((a) => {
                const conn = connections.find((c) => c.id === a.connection_id);
                return (
                  <div key={a.id} className="list-item" style={{ flexWrap: 'wrap' }}>
                    <div className="grow" style={{ minWidth: 180 }}>
                      <Link to={`/transactions?account=${a.id}`} style={{ fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}>
                        {a.name}
                      </Link>
                      <div className="small muted">
                        {KIND_LABEL[a.kind] ?? a.kind}
                        {a.institution ? ` · ${a.institution}` : ''}
                        {' · '}
                        {conn ? (
                          <span style={{ color: conn.status === 'active' ? undefined : 'var(--bad)' }}>
                            {conn.status === 'active' ? `Synkronisert ${timeAgo(conn.last_sync_at)}` : conn.status === 'expired' ? 'Koblingen har utløpt' : 'Problem med synkronisering'}
                          </span>
                        ) : a.last_date ? (
                          `Oppdatert til ${dayLabel(a.last_date)}`
                        ) : (
                          'Ingen transaksjoner ennå'
                        )}
                        {a.unreviewed > 0 && (
                          <>
                            {' · '}
                            <Link to="/review">{a.unreviewed} å gå gjennom</Link>
                          </>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 650 }}>
                        <Money value={a.balance} />
                      </div>
                      {a.bank_balance !== null && a.bank_balance !== a.balance && (
                        <div className="small" style={{ color: 'var(--warn)' }} title="Banken oppgir en annen saldo. Bruk Endre → Rett saldo for å justere.">
                          Banken: {kr(a.bank_balance)}
                        </div>
                      )}
                    </div>
                    <div className="row" style={{ gap: 4 }}>
                      {conn && conn.status === 'active' && (
                        <button className="btn sm" onClick={() => sync(conn.id)} disabled={syncing !== null}>
                          <Icon name="sync" size={14} /> {syncing === conn.id ? 'Synkroniserer…' : 'Synkroniser'}
                        </button>
                      )}
                      {conn && conn.status !== 'active' && (
                        <button className="btn sm primary" onClick={() => reconnect(conn)}>
                          Koble til på nytt
                        </button>
                      )}
                      <button className="btn sm" onClick={() => setImportInto(a)}>
                        <Icon name="upload" size={14} /> Importer
                      </button>
                      <button className="icon-btn" onClick={() => setEditing(a)} aria-label={`Endre ${a.name}`}>
                        <Icon name="edit" size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

      {connections.length > 0 && (
        <section>
          <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Bankkoblinger</h2>
          <div className="card list">
            {connections.map((c) => {
              const daysLeft = c.expires_at ? Math.round((Date.parse(c.expires_at) - Date.now()) / 86_400_000) : null;
              return (
                <div key={c.id} className="list-item" style={{ flexWrap: 'wrap' }}>
                  <div className="grow" style={{ minWidth: 200 }}>
                    <div style={{ fontWeight: 600 }}>
                      {c.name} <span className="chip">{c.providerLabel}</span>
                    </div>
                    <div className="small muted">
                      {c.status === 'active' && `Sist synkronisert ${timeAgo(c.last_sync_at)}`}
                      {c.status === 'linking' && 'Velg hvilke kontoer som skal synkroniseres'}
                      {c.status === 'expired' && 'Utløpt. Logg inn med BankID igjen.'}
                      {c.status === 'error' && `Feil: ${c.last_error}`}
                      {daysLeft !== null && c.status === 'active' && (
                        <span style={{ color: daysLeft < 8 ? 'var(--warn)' : undefined }}>
                          {' · '}BankID-fornyelse om {Math.max(0, daysLeft)} dager
                        </span>
                      )}
                      {' · '}
                      {c.accounts.filter((a) => a.account_id).map((a) => a.account_name).join(', ') || 'ingen kontoer koblet'}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    {c.status === 'linking' && (
                      <button className="btn sm primary" onClick={() => setParams({ link: String(c.id) })}>
                        Velg kontoer
                      </button>
                    )}
                    {(c.status !== 'active' || (daysLeft !== null && daysLeft < 14)) && (
                      <button className="btn sm" onClick={() => reconnect(c)}>
                        {c.status === 'active' ? 'Forny nå' : 'Koble til på nytt'}
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      aria-label="Fjern koblingen"
                      title="Fjern koblingen (kontoer og transaksjoner beholdes)"
                      onClick={async () => {
                        if (!confirm(`Slutte å synkronisere ${c.name}? Kontoene og transaksjonene beholdes.`)) return;
                        await api.del(`/connections/${c.id}`);
                        await Promise.all([loadConnections(), refresh()]);
                      }}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {adding && (
        <AddAccount
          onClose={() => setAdding(false)}
          onCreatedForImport={(a) => {
            setAdding(false);
            setImportInto(a);
          }}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {importInto && (
        <ImportWizard
          account={importInto}
          onClose={() => setImportInto(null)}
          onDone={() => {
            refresh();
          }}
        />
      )}
      {editing && <EditAccount account={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), refresh())} />}
      {linking && (
        <LinkAccounts
          connection={linking}
          accounts={summary.accounts}
          onClose={() => setParams({})}
          onDone={async (r) => {
            setParams({});
            toast(`Tilkoblet! ${describeResult(r)}`, { action: { label: 'Gjennomgå', run: () => navigate('/review') } });
            await Promise.all([loadConnections(), refresh()]);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
type Method = 'bank' | 'file' | 'manual';

function AddAccount({
  onClose,
  onDone,
  onCreatedForImport,
}: {
  onClose: () => void;
  onDone: () => void;
  onCreatedForImport: (a: Account) => void;
}) {
  const [method, setMethod] = useState<Method | null>(null);
  return (
    <Modal title="Legg til konto" onClose={onClose} wide>
      {!method && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Hvordan skal transaksjonene komme inn? Du kan endre dette senere, og hver konto kan bruke sin egen metode.
          </p>
          <div className="option-grid">
            <button className="option" onClick={() => setMethod('bank')}>
              <strong>🔄 Koble til med BankID</strong>
              <span className="small muted">Automatisk synkronisering fire ganger i døgnet. Best for SpareBank 1, DNB og Revolut.</span>
            </button>
            <button className="option" onClick={() => setMethod('file')}>
              <strong>📄 Importer en fil</strong>
              <span className="small muted">Last ned en CSV-fil fra nettbanken og slipp den her. Fint for TF Bank.</span>
            </button>
            <button className="option" onClick={() => setMethod('manual')}>
              <strong>✍️ Før manuelt</strong>
              <span className="small muted">Bare saldoen. Legg inn transaksjoner for hånd, for eksempel kontanter.</span>
            </button>
          </div>
        </>
      )}
      {method === 'bank' && <ConnectBank onBack={() => setMethod(null)} />}
      {(method === 'file' || method === 'manual') && (
        <ManualAccount
          forImport={method === 'file'}
          onBack={() => setMethod(null)}
          onCreated={(a) => (method === 'file' ? onCreatedForImport(a) : onDone())}
        />
      )}
    </Modal>
  );
}

function ConnectBank({ onBack }: { onBack: () => void }) {
  const [providers, setProviders] = useState<Array<{ id: string; label: string; description: string; configured: boolean }>>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [banks, setBanks] = useState<Array<{ id: string; name: string; logo?: string }> | null>(null);
  const [filter, setFilter] = useState('');
  const [country, setCountry] = useState('NO');
  const [bank, setBank] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ providers: any[] }>('/settings').then((s) => setProviders(s.providers));
  }, []);

  useEffect(() => {
    if (provider !== 'enablebanking') return;
    setBanks(null);
    api
      .get<Array<{ id: string; name: string; logo?: string }>>(`/banks/${provider}?country=${country}`)
      .then(setBanks)
      .catch((e) => setError(e.message));
  }, [provider, country]);

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await api.post<{ url: string }>('/connections/start', { provider, bankId: bank });
      window.location.href = url; // Off to BankID; the bank sends you back here afterwards.
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const p = providers.find((x) => x.id === provider);
  const shown = (banks ?? []).filter((b) => b.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <Icon name="left" size={14} /> Tilbake
      </button>
      <div className="option-grid">
        {providers.map((x) => (
          <button key={x.id} className={`option ${provider === x.id ? 'on' : ''}`} onClick={() => setProvider(x.id)}>
            <strong>
              {x.label} {x.configured ? '' : <span className="chip">må settes opp</span>}
            </strong>
            <span className="small muted">{x.description}</span>
          </button>
        ))}
      </div>
      {p && !p.configured && (
        <div className="callout warn small">
          <Icon name="alert" size={18} />
          <div>
            {p.label} trenger API-nøkler før den kan koble til. Det er et engangsoppsett som tar rundt 5 minutter.{' '}
            <Link to="/settings">Åpne Innstillinger</Link> for steg-for-steg-instruksjoner.
          </div>
        </div>
      )}
      {p?.configured && provider === 'enablebanking' && (
        <>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input" placeholder="Søk etter banken (f.eks. DNB, SpareBank 1)" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <select className="select" style={{ width: 'auto' }} value={country} onChange={(e) => (setCountry(e.target.value), setBank(null))} aria-label="Land">
              <option value="NO">Norge</option>
              <option value="LT">Litauen (Revolut)</option>
              <option value="SE">Sverige</option>
              <option value="FI">Finland</option>
              <option value="DK">Danmark</option>
            </select>
          </div>
          {country === 'NO' && filter.toLowerCase().includes('revolut') && shown.length === 0 && (
            <div className="small muted">Revolut er en litauisk bank. Velg «Litauen (Revolut)» i listen ved siden av.</div>
          )}
          <div className="card list" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {!banks && !error && <div className="list-item muted">Henter banker…</div>}
            {shown.map((b) => (
              <button
                key={b.id}
                className="list-item"
                style={{ border: 'none', background: bank === b.id ? 'var(--brand-soft)' : 'transparent', cursor: 'pointer', textAlign: 'left', width: '100%' }}
                onClick={() => setBank(b.id)}
              >
                {b.logo && <img src={b.logo} alt="" width={24} height={24} style={{ objectFit: 'contain' }} />}
                <span className="grow">{b.name}</span>
                {bank === b.id && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
        </>
      )}
      {error && <div className="callout bad small">{error}</div>}
      {p?.configured && (
        <div className="row">
          <span className="small muted spacer">Du logger inn med BankID hos banken, og kommer rett tilbake hit.</span>
          <button className="btn primary" disabled={busy || (provider === 'enablebanking' && !bank)} onClick={go}>
            {busy ? 'Åpner banken…' : 'Fortsett til BankID'}
          </button>
        </div>
      )}
    </>
  );
}

function ManualAccount({ forImport, onBack, onCreated }: { forImport: boolean; onBack: () => void; onCreated: (a: Account) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('checking');
  const [onBudget, setOnBudget] = useState(true);
  const [balance, setBalance] = useState(0);
  const { refresh } = useStore();
  const isDebt = kind === 'credit' || kind === 'loan';
  const toast = useToast();

  const create = async () => {
    try {
      const { id } = await api.post<{ id: number }>('/accounts', {
        name,
        kind,
        on_budget: onBudget,
        balance: forImport ? 0 : isDebt ? -Math.abs(balance) : balance,
      });
      await refresh();
      onCreated({ id, name, kind, on_budget: onBudget ? 1 : 0 } as Account);
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };

  return (
    <>
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <Icon name="left" size={14} /> Tilbake
      </button>
      <label className="field">
        Navn
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="f.eks. TF Bank Mastercard" />
      </label>
      <label className="field">
        Type
        <select
          className="select"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setOnBudget(e.target.value !== 'loan' && e.target.value !== 'savings' ? true : onBudget && e.target.value !== 'loan');
          }}
        >
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {!forImport && (
        <label className="field">
          {isDebt ? 'Hvor mye skylder du nå?' : 'Saldo nå'}
          <MoneyInput value={balance} onCommit={setBalance} />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={onBudget} onChange={(e) => setOnBudget(e.target.checked)} />
        <span>
          Bruk i budsjettet
          <div className="small muted">
            Slå av for boliglån, BSU eller investeringer: de teller i formuen, ikke i det dere kan bruke.
          </div>
        </span>
      </label>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={!name.trim()} onClick={create}>
          {forImport ? 'Neste: velg fil' : 'Legg til konto'}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
interface Preview {
  format: string;
  headers: string[];
  sample: string[][];
  mapping: any;
  warnings: string[];
  count: number;
  skipped: number;
  alreadyImported: number;
  from?: string;
  to?: string;
  inflow: number;
  outflow: number;
  preview: Array<{ date: string; amount: number; description: string; payee: string }>;
}

/** Banks often export in Windows-1252 (æøå would turn into garbage as UTF-8). Try UTF-8 first, then fall back. */
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function ImportWizard({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<any>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [over, setOver] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  const runPreview = async (t: string, m?: any) => {
    try {
      const p = await api.post<Preview>('/import/preview', { accountId: account.id, text: t, mapping: m });
      setPreview(p);
      setMapping(p.mapping);
    } catch (e: any) {
      toast(e.message, { error: true });
    }
  };

  const onFile = async (file: File) => {
    const t = await readText(file);
    setFileName(file.name);
    setText(t);
    runPreview(t);
  };

  const updateMapping = (patch: any) => {
    const m = { ...mapping, ...patch };
    setMapping(m);
    runPreview(text!, m);
  };

  const commit = async () => {
    setBusy(true);
    try {
      // Sent in slices so each request stays small; the server says where to continue.
      const total: IngestResult = { added: 0, duplicates: 0, matched: 0, categorized: 0, transfers: 0 };
      for (let offset: number | null = 0; offset !== null; ) {
        const r: IngestResult & { next: number | null; total: number } = await api.post('/import/commit', { accountId: account.id, text, mapping, offset });
        for (const k of ['added', 'duplicates', 'matched', 'categorized', 'transfers'] as const) total[k] += r[k];
        setProgress(r.next === null ? null : `${r.next} av ${r.total}`);
        offset = r.next;
      }
      setResult(total);
      onDone();
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  const colSelect = (key: string, label: string, optional = true) => (
    <label className="field" style={{ flex: '1 1 150px' }}>
      {label}
      <select
        className="select"
        value={mapping?.[key] ?? ''}
        onChange={(e) => updateMapping({ [key]: e.target.value === '' ? undefined : Number(e.target.value) })}
      >
        {optional && <option value="">—</option>}
        {preview!.headers.map((h, i) => (
          <option key={i} value={i}>
            {h || `Kolonne ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Modal title={`Importer til ${account.name}`} onClose={onClose} wide>
      {result ? (
        <>
          <div className="callout good">
            <Icon name="check" size={20} />
            <div>
              <strong>Importert!</strong>
              <div className="small">{describeResult(result)}</div>
              {result.categorized > 0 && <div className="small">{result.categorized} fikk kategoriforslag automatisk.</div>}
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>
              Ferdig
            </button>
            {result.added > 0 && (
              <button className="btn primary" onClick={() => navigate('/review')}>
                Gå gjennom {result.added} transaksjoner
              </button>
            )}
          </div>
        </>
      ) : !text ? (
        <>
          <label
            className={`drop ${over ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f) onFile(f);
            }}
          >
            <Icon name="upload" size={28} />
            <div style={{ fontWeight: 600, marginTop: 6 }}>Slipp en CSV-fil her, eller klikk for å velge</div>
            <div className="small">Fungerer med SpareBank 1, DNB, Revolut, TF Bank og de fleste andre banker</div>
            <input type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>
          <details className="small muted">
            <summary>Hvor finner jeg filen?</summary>
            <ul>
              <li>
                <strong>SpareBank 1:</strong> Nettbanken → kontoen → Transaksjoner → «Eksporter» → CSV.
              </li>
              <li>
                <strong>DNB:</strong> Nettbanken → kontoen → «Last ned» → CSV (Excel).
              </li>
              <li>
                <strong>Revolut:</strong> Appen → kontoen → ⋯ → Kontoutskrift → Excel/CSV.
              </li>
              <li>
                <strong>TF Bank:</strong> Min side → kortet → Transaksjoner → Eksporter. Får du bare PDF, legg inn transaksjonene
                manuelt, eller lim dem inn i et regneark og lagre som CSV.
              </li>
            </ul>
            Det er trygt å importere samme fil to ganger: duplikater hoppes over automatisk.
          </details>
        </>
      ) : preview ? (
        <>
          <div className="row">
            <span className="chip brand">{preview.format === 'Generell' ? 'Fant kolonnene' : `Gjenkjent: ${preview.format}`}</span>
            <span className="small muted">{fileName}</span>
          </div>
          <div className="small">
            <strong>{preview.count}</strong> transaksjoner
            {preview.from && (
              <>
                {' '}
                fra {dayLabel(preview.from)} til {dayLabel(preview.to!)}
              </>
            )}{' '}
            · inn <Money value={preview.inflow} /> · ut <Money value={preview.outflow} />
            {preview.alreadyImported > 0 && <span className="muted"> · {preview.alreadyImported} er importert fra før (hoppes over)</span>}
            {preview.skipped > 0 && <span className="muted"> · {preview.skipped} rader hoppet over (ventende, reversert eller uleselig)</span>}
          </div>
          {preview.warnings.map((w) => (
            <div key={w} className="callout warn small">
              <Icon name="alert" size={18} />
              {w}
            </div>
          ))}
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Dato</th>
                  <th>Mottaker (ryddet)</th>
                  <th className="right">Beløp</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((r, i) => (
                  <tr key={i}>
                    <td className="num muted">{dayLabel(r.date)}</td>
                    <td>
                      <div>{r.payee}</div>
                      <div className="small faint ellipsis" style={{ maxWidth: 380 }}>
                        {r.description}
                      </div>
                    </td>
                    <td className="right">
                      <Money value={r.amount} sign />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <label className="check small">
              <input type="checkbox" checked={!!mapping?.invert} onChange={(e) => updateMapping({ invert: e.target.checked })} />
              Snu fortegn (kjøp skal være negative)
            </label>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setShowCols((v) => !v)}>
              {showCols ? 'Skjul kolonner' : 'Ser noe feil ut? Juster kolonnene'}
            </button>
          </div>
          {showCols && (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              {colSelect('date', 'Dato', false)}
              {colSelect('description', 'Beskrivelse', false)}
              {colSelect('amount', 'Beløp (+/−)')}
              {colSelect('inflow', 'Inn')}
              {colSelect('outflow', 'Ut')}
              <label className="field" style={{ flex: '1 1 150px' }}>
                Datoformat
                <select className="select" value={mapping.dateFormat} onChange={(e) => updateMapping({ dateFormat: e.target.value })}>
                  <option value="dmy">31.12.2026</option>
                  <option value="ymd">2026-12-31</option>
                  <option value="mdy">12/31/2026</option>
                </select>
              </label>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn ghost"
              onClick={() => {
                setText(null);
                setPreview(null);
              }}
            >
              Velg en annen fil
            </button>
            <button className="btn primary" disabled={busy || preview.count === 0} onClick={commit}>
              {busy ? `Importerer…${progress ? ` (${progress})` : ''}` : `Importer ${preview.count - preview.alreadyImported} transaksjoner`}
            </button>
          </div>
        </>
      ) : (
        <div className="muted">Leser filen…</div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
function LinkAccounts({
  connection,
  accounts,
  onClose,
  onDone,
}: {
  connection: Connection;
  accounts: Account[];
  onClose: () => void;
  onDone: (r: IngestResult) => void;
}) {
  const discovered = useMemo(
    () =>
      connection.accounts.map((ca) => ({
        ...ca,
        info: connection.discovered.find((d) => d.remoteId === ca.remote_id),
      })),
    [connection],
  );
  const [choices, setChoices] = useState(() =>
    Object.fromEntries(
      discovered.map((d) => [
        d.remote_id,
        {
          choice: d.account_id ? String(d.account_id) : 'new',
          name: d.info?.name ? `${d.info.name}` : d.remote_name,
          kind: d.info?.kind ?? 'checking',
          onBudget: d.info?.kind !== 'savings',
        },
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const toast = useToast();
  const set = (id: string, patch: any) => setChoices((c) => ({ ...c, [id]: { ...c[id], ...patch } }));

  const save = async () => {
    setBusy(true);
    try {
      const payload = discovered.map((d) => {
        const c = choices[d.remote_id];
        if (c.choice === 'skip') return { remoteId: d.remote_id, accountId: null };
        if (c.choice === 'new') return { remoteId: d.remote_id, create: { name: c.name, kind: c.kind, onBudget: c.onBudget } };
        return { remoteId: d.remote_id, accountId: Number(c.choice) };
      });
      const { accounts } = await api.post<{ accounts: string[] }>(`/connections/${connection.id}/link`, { choices: payload });
      // First sync one account at a time, so no single request gets too big.
      const total: IngestResult = { added: 0, duplicates: 0, matched: 0, categorized: 0, transfers: 0, errors: [] };
      for (const [i, remoteId] of accounts.entries()) {
        setProgress(`${i + 1} av ${accounts.length}`);
        const r = await api.post<IngestResult>(`/connections/${connection.id}/sync?account=${encodeURIComponent(remoteId)}`);
        for (const k of ['added', 'duplicates', 'matched', 'categorized', 'transfers'] as const) total[k] += r[k];
        total.errors!.push(...(r.errors ?? []));
      }
      onDone(total);
    } catch (e: any) {
      toast(e.message, { error: true });
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Velg kontoer fra ${connection.name}`}
      onClose={onClose}
      wide
      footer={
        <button className="btn primary" disabled={busy} onClick={save}>
          {busy ? `Synkroniserer konto ${progress}…` : 'Lagre og synkroniser'}
        </button>
      }
    >
      <p className="muted small" style={{ margin: 0 }}>
        Vi fant disse kontoene. Velg hvilke som skal synkroniseres, og om det skal lages en ny konto eller kobles til en du allerede har
        lagt til (f.eks. fra en CSV-import; duplikater hoppes over).
      </p>
      {discovered.map((d) => {
        const c = choices[d.remote_id];
        return (
          <div key={d.remote_id} className="card card-pad stack" style={{ gap: 8 }}>
            <div className="row">
              <strong className="spacer">{d.remote_name}</strong>
              {d.info?.balance !== undefined && <Money value={d.info.balance} />}
            </div>
            <select className="select" value={c.choice} onChange={(e) => set(d.remote_id, { choice: e.target.value })}>
              <option value="new">Lag en ny konto</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  Koble til «{a.name}»
                </option>
              ))}
              <option value="skip">Ikke synkroniser denne</option>
            </select>
            {c.choice === 'new' && (
              <div className="row">
                <input className="input" style={{ flex: '2 1 200px' }} value={c.name} onChange={(e) => set(d.remote_id, { name: e.target.value })} />
                <select className="select" style={{ flex: '1 1 140px' }} value={c.kind} onChange={(e) => set(d.remote_id, { kind: e.target.value })}>
                  {Object.entries(KIND_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <label className="check small">
                  <input type="checkbox" checked={c.onBudget} onChange={(e) => set(d.remote_id, { onBudget: e.target.checked })} />
                  I budsjettet
                </label>
              </div>
            )}
          </div>
        );
      })}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
function EditAccount({ account, onClose, onSaved }: { account: Account; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(account.name);
  const [kind, setKind] = useState(account.kind);
  const [onBudget, setOnBudget] = useState(!!account.on_budget);
  const [reconcile, setReconcile] = useState<number | null>(null);
  const toast = useToast();

  const save = async () => {
    await api.patch(`/accounts/${account.id}`, {
      name,
      kind,
      on_budget: onBudget,
      ...(reconcile !== null ? { reconcileTo: reconcile } : {}),
    });
    if (reconcile !== null && reconcile !== account.balance) toast(`La til en justering på ${kr(reconcile - account.balance)}. Gå gjennom den for å gi den en kategori.`);
    onSaved();
  };

  return (
    <Modal
      title={`Endre ${account.name}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn ghost danger"
            style={{ marginRight: 'auto' }}
            onClick={async () => {
              if (!confirm(`Slette ${account.name} og alle transaksjonene? Dette kan ikke angres. (Tips: «Avslutt konto» beholder historikken.)`)) return;
              await api.del(`/accounts/${account.id}`);
              onSaved();
            }}
          >
            Slett
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              await api.patch(`/accounts/${account.id}`, { closed: !account.closed });
              onSaved();
            }}
          >
            {account.closed ? 'Gjenåpne' : 'Avslutt konto'}
          </button>
          <button className="btn primary" onClick={save}>
            Lagre
          </button>
        </>
      }
    >
      <label className="field">
        Navn
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Type
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Account['kind'])}>
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={onBudget} onChange={(e) => setOnBudget(e.target.checked)} /> Bruk i budsjettet
      </label>
      <label className="field">
        Rett saldo
        <span className="help">
          Saldoen her er {kr(account.balance)}
          {account.bank_balance !== null ? `, banken sier ${kr(account.bank_balance)}` : ''}. Skriv inn riktig saldo for å legge til en justering.
        </span>
        <MoneyInput value={reconcile ?? account.bank_balance ?? account.balance} onCommit={setReconcile} />
      </label>
    </Modal>
  );
}
