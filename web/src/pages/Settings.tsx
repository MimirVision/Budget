import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { CategorySelect, Icon, useToast } from '../components/ui';

interface ProviderSettings {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  callbackUrl: string;
  settings: Array<{ key: string; label: string; secret?: boolean; multiline?: boolean; help?: string; isSet: boolean; value?: string }>;
}

interface Rule {
  id: number;
  match_type: 'contains' | 'equals' | 'starts';
  pattern: string;
  category_id: number | null;
  category_name: string | null;
  rename_to: string | null;
  hits: number;
}

interface Group {
  id: number;
  name: string;
  is_income: number;
  hidden: number;
  categories: Array<{ id: number; name: string; hidden: number }>;
}

const TABS = ['Kategorier', 'Regler', 'Banksynkronisering'] as const;

export default function SettingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Kategorier');
  return (
    <>
      <div className="page-head">
        <h1>Innstillinger</h1>
        <div className="seg">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === 'Kategorier' && <Categories />}
      {tab === 'Regler' && <Rules />}
      {tab === 'Banksynkronisering' && <BankSync />}
    </>
  );
}

function Categories() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [newGroup, setNewGroup] = useState('');
  const { refresh } = useStore();
  const toast = useToast();
  const load = useCallback(() => api.get<{ groups: Group[] }>('/categories').then((r) => setGroups(r.groups)), []);
  useEffect(() => {
    load();
  }, [load]);
  const after = async () => {
    await Promise.all([load(), refresh()]);
  };
  const patchCat = async (id: number, body: any) => {
    await api.patch(`/categories/${id}`, body);
    after();
  };
  const patchGroup = async (id: number, body: any) => {
    await api.patch(`/category-groups/${id}`, body);
    after();
  };

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Klikk på et navn for å endre det. Skjulte kategorier beholder historikken, men er ute av veien. Inntektskategorier går til
        «Klar til fordeling».
      </p>
      {groups.map((g) => (
        <div key={g.id} className="card">
          <div className="list-item" style={{ background: 'var(--surface-2)', borderRadius: '12px 12px 0 0' }}>
            <InlineName value={g.name} onSave={(name) => patchGroup(g.id, { name })} bold />
            {g.is_income ? <span className="chip brand">Inntekt</span> : null}
            <span className="spacer" />
            {!g.is_income && (
              <>
                <button className="icon-btn" onClick={() => patchGroup(g.id, { move: 'up' })} aria-label="Flytt gruppen opp">
                  <Icon name="up" size={16} />
                </button>
                <button className="icon-btn" onClick={() => patchGroup(g.id, { move: 'down' })} aria-label="Flytt gruppen ned">
                  <Icon name="down" size={16} />
                </button>
                <button className="icon-btn" onClick={() => patchGroup(g.id, { hidden: !g.hidden })} aria-label={g.hidden ? 'Vis gruppen' : 'Skjul gruppen'}>
                  <Icon name={g.hidden ? 'eyeOff' : 'eye'} size={16} />
                </button>
                {g.categories.length === 0 && (
                  <button
                    className="icon-btn"
                    aria-label="Slett gruppen"
                    onClick={async () => {
                      await api.del(`/category-groups/${g.id}`);
                      after();
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                )}
              </>
            )}
          </div>
          {g.categories.map((c) => (
            <div key={c.id} className="list-item" style={{ opacity: c.hidden ? 0.55 : 1, paddingLeft: 28 }}>
              <InlineName value={c.name} onSave={(name) => patchCat(c.id, { name })} />
              <span className="spacer" />
              <select
                className="select"
                style={{ width: 'auto', minHeight: 30, padding: '2px 6px', fontSize: 13 }}
                value={g.id}
                aria-label="Flytt til gruppe"
                onChange={(e) => patchCat(c.id, { group_id: Number(e.target.value) })}
              >
                {groups.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <button className="icon-btn" onClick={() => patchCat(c.id, { move: 'up' })} aria-label="Flytt opp">
                <Icon name="up" size={16} />
              </button>
              <button className="icon-btn" onClick={() => patchCat(c.id, { move: 'down' })} aria-label="Flytt ned">
                <Icon name="down" size={16} />
              </button>
              <button className="icon-btn" onClick={() => patchCat(c.id, { hidden: !c.hidden })} aria-label={c.hidden ? 'Vis' : 'Skjul'}>
                <Icon name={c.hidden ? 'eyeOff' : 'eye'} size={16} />
              </button>
              <button
                className="icon-btn"
                aria-label="Slett kategorien"
                onClick={async () => {
                  const others = groups.flatMap((x) => x.categories).filter((x) => x.id !== c.id && !x.hidden);
                  const target = prompt(
                    `Slette «${c.name}»? Skriv navnet på kategorien som skal få transaksjonene og pengene (la feltet stå tomt for å gjøre dem ukategoriserte):\n\n${others.map((o) => o.name).join(', ')}`,
                  );
                  if (target === null) return;
                  const into = others.find((o) => o.name.toLowerCase() === target.trim().toLowerCase());
                  if (target.trim() && !into) return toast(`Fant ingen kategori som heter «${target}»`, { error: true });
                  await api.del(`/categories/${c.id}${into ? `?reassign=${into.id}` : ''}`);
                  toast(into ? `Slettet. Alt er flyttet til ${into.name}.` : 'Slettet');
                  after();
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
          <AddCategory groupId={g.id} onAdded={after} />
        </div>
      ))}
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!newGroup.trim()) return;
          await api.post('/category-groups', { name: newGroup });
          setNewGroup('');
          after();
        }}
      >
        <input className="input" style={{ maxWidth: 280 }} placeholder="Navn på ny gruppe" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
        <button className="btn">
          <Icon name="plus" size={16} /> Legg til gruppe
        </button>
      </form>
    </div>
  );
}

function InlineName({ value, onSave, bold }: { value: string; onSave: (v: string) => void; bold?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="assign-input"
      style={{ textAlign: 'left', width: 'min(320px, 50vw)', fontWeight: bold ? 700 : 500 }}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() && text !== value && onSave(text)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function AddCategory({ groupId, onAdded }: { groupId: number; onAdded: () => void }) {
  const [name, setName] = useState('');
  return (
    <form
      className="list-item"
      style={{ paddingLeft: 28 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        await api.post('/categories', { name, group_id: groupId });
        setName('');
        onAdded();
      }}
    >
      <input className="input" style={{ maxWidth: 280, minHeight: 32 }} placeholder="+ Legg til kategori" value={name} onChange={(e) => setName(e.target.value)} />
      {name && <button className="btn sm primary">Legg til</button>}
    </form>
  );
}

function Rules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [pattern, setPattern] = useState('');
  const [matchType, setMatchType] = useState<Rule['match_type']>('contains');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const { summary, refresh } = useStore();
  const toast = useToast();
  const load = useCallback(() => api.get<Rule[]>('/rules').then(setRules), []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Regler brukes på hver nye transaksjon, enten den kommer fra banken, en fil eller manuell føring. Haker du av for «Alltid…» under
        gjennomgang, lages en regel for deg. Selv uten regler lærer appen av det du valgte sist.
      </p>
      <form
        className="card card-pad stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post('/rules', { pattern, match_type: matchType, category_id: categoryId, rename_to: renameTo, apply_existing: true });
            setPattern('');
            setRenameTo('');
            setCategoryId(null);
            toast('Regelen er lagt til og brukt på transaksjoner som venter på gjennomgang');
            await Promise.all([load(), refresh()]);
          } catch (err: any) {
            toast(err.message, { error: true });
          }
        }}
      >
        <h3 style={{ margin: 0 }}>Ny regel</h3>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '0 1 150px' }}>
            Når teksten
            <select className="select" value={matchType} onChange={(e) => setMatchType(e.target.value as Rule['match_type'])}>
              <option value="contains">inneholder</option>
              <option value="starts">starter med</option>
              <option value="equals">er nøyaktig</option>
            </select>
          </label>
          <label className="field" style={{ flex: '1 1 180px' }}>
            &nbsp;
            <input className="input" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="f.eks. klatresenter" />
          </label>
          <label className="field" style={{ flex: '1 1 200px' }}>
            Legg den i
            <CategorySelect categories={summary?.categories ?? []} value={categoryId} onChange={setCategoryId} placeholder="(ikke endre)" />
          </label>
          <label className="field" style={{ flex: '1 1 160px' }}>
            Gi mottakeren navnet
            <input className="input" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder="(valgfritt)" />
          </label>
          <button className="btn primary" disabled={!pattern.trim() || (!categoryId && !renameTo.trim())}>
            Legg til regel
          </button>
        </div>
      </form>
      <div className="card">
        {rules.length === 0 ? (
          <div className="empty">Ingen regler ennå.</div>
        ) : (
          <div className="list">
            {rules.map((r) => (
              <div key={r.id} className="list-item">
                <div className="grow">
                  Teksten {r.match_type === 'contains' ? 'inneholder' : r.match_type === 'starts' ? 'starter med' : 'er'} <strong>«{r.pattern}»</strong>
                  {r.category_name && (
                    <>
                      {' '}
                      → <span className="chip brand">{r.category_name}</span>
                    </>
                  )}
                  {r.rename_to && <> · gi navnet «{r.rename_to}»</>}
                  <div className="small faint">Brukt {r.hits} ganger</div>
                </div>
                <button
                  className="icon-btn"
                  aria-label="Slett regelen"
                  onClick={async () => {
                    await api.del(`/rules/${r.id}`);
                    load();
                  }}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function BankSync() {
  const [data, setData] = useState<{ publicUrl: string; passwordEnabled: boolean; providers: ProviderSettings[] } | null>(null);
  const load = useCallback(() => api.get<any>('/settings').then(setData), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return null;
  return (
    <div className="stack">
      <div className="callout info small">
        <Icon name="bank" size={18} />
        <div>
          Norske banker deler transaksjonene dine gjennom åpen bank (PSD2), men bare via en godkjent tilbyder. Sett opp én av disse (eller
          begge) én gang. Deretter er det bare BankID for å koble til en bank. Nøklene lagres i din egen database og vises aldri igjen
          etter at de er lagret.
        </div>
      </div>
      {data.providers.map((p) => (
        <ProviderCard key={p.id} p={p} onSaved={load} />
      ))}
      <div className="card card-pad small">
        <h3>Anbefalt oppsett for bankene deres</h3>
        <table className="table">
          <tbody>
            <tr>
              <td>SpareBank 1 Sør-Norge</td>
              <td>Enable Banking, eller SpareBank 1 direkte (gratis, laget for privat bruk)</td>
            </tr>
            <tr>
              <td>DNB kredittkort</td>
              <td>Enable Banking</td>
            </tr>
            <tr>
              <td>Revolut</td>
              <td>Enable Banking (eller CSV-eksport fra appen)</td>
            </tr>
            <tr>
              <td>TF Bank kredittkort</td>
              <td>Enable Banking hvis kortet står i listen, ellers CSV-import eller manuell føring</td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          Bankene krever at du bekrefter med BankID på nytt omtrent hver 90.–180. dag. Appen varsler deg en uke før. Synkroniseringen
          kjører automatisk hver fjerde time så lenge serveren kjører.
          {!data.passwordEnabled && ' Tips: sett APP_PASSWORD i .env før appen gjøres tilgjengelig på internett.'}
        </p>
      </div>
    </div>
  );
}

const SETUP_STEPS: Record<string, (callback: string) => React.ReactNode> = {
  enablebanking: (callback) => (
    <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
      <li>
        Registrer deg på <a href="https://enablebanking.com/sign-in/" target="_blank" rel="noreferrer">enablebanking.com</a> (gratis for å koble
        til egne kontoer).
      </li>
      <li>
        Gå til kontrollpanelet → <em>Applications</em> → <em>Register new application</em>. Velg miljøet <strong>Production</strong>,
        og la den lage en privat nøkkel i nettleseren. Lagre .pem-filen.
      </li>
      <li>
        Legg inn denne som redirect-URL: <code style={{ userSelect: 'all' }}>{callback}</code>
      </li>
      <li>Aktiver applikasjonen ved å koble til egne kontoer (begrenset modus). Du trenger verken firma eller avtale.</li>
      <li>Lim inn applikasjons-ID-en under, og velg .pem-filen med «Velg nøkkelfil».</li>
    </ol>
  ),
  sparebank1: (callback) => (
    <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
      <li>
        Logg inn på <a href="https://developer.sparebank1.no" target="_blank" rel="noreferrer">developer.sparebank1.no</a> med BankID og åpne{' '}
        <em>Personlig klient</em>.
      </li>
      <li>
        Lag en klient med redirect-URL <code style={{ userSelect: 'all' }}>{callback}</code>
      </li>
      <li>Kopier klient-ID og hemmelighet, og finn bankens ID (finInst) i banklisten på samme side.</li>
    </ol>
  ),
};

function ProviderCard({ p, onSaved }: { p: ProviderSettings; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(p.settings.map((s) => [s.key, s.value ?? ''])));
  const [open, setOpen] = useState(!p.configured);
  const toast = useToast();
  const save = async () => {
    const body: Record<string, string> = {};
    for (const s of p.settings) {
      // Leave secrets alone unless you typed a new one.
      if (s.secret && !values[s.key]) continue;
      body[s.key] = values[s.key];
    }
    await api.put('/settings', body);
    toast(`${p.label} er lagret`);
    onSaved();
    setOpen(false);
  };
  return (
    <div className="card card-pad stack">
      <div className="row">
        <div className="spacer">
          <h3 style={{ margin: 0 }}>
            {p.label} {p.configured ? <span className="pill good small">Klar</span> : <span className="pill zero small">Ikke satt opp</span>}
          </h3>
          <div className="small muted">{p.description}</div>
        </div>
        <button className="btn sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Lukk' : p.configured ? 'Bytt nøkler' : 'Sett opp'}
        </button>
      </div>
      {open && (
        <>
          {SETUP_STEPS[p.id]?.(p.callbackUrl)}
          {p.settings.map((s) => (
            <label key={s.key} className="field">
              {s.label}
              {s.help && <span className="help">{s.help}</span>}
              {s.multiline ? (
                <>
                  {/* On a phone it's much easier to pick the downloaded .pem file than to copy its text. */}
                  <label className="btn sm" style={{ alignSelf: 'flex-start' }}>
                    <Icon name="upload" size={14} /> Velg nøkkelfil (.pem)
                    <input
                      type="file"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const text = await file.text();
                        if (!text.includes('PRIVATE KEY')) return toast('Det ser ikke ut som en privat nøkkel (.pem)', { error: true });
                        setValues((v) => ({ ...v, [s.key]: text.trim() }));
                        toast(`Nøkkel lest fra ${file.name}. Trykk Lagre.`);
                      }}
                    />
                  </label>
                  <textarea
                    className="input"
                    rows={4}
                    style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                    placeholder={s.isSet ? '•••••• lagret. Velg en ny fil eller lim inn for å bytte' : 'eller lim inn: -----BEGIN PRIVATE KEY-----'}
                    value={values[s.key]}
                    onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
                  />
                </>
              ) : (
                <input
                  className="input"
                  type={s.secret ? 'password' : 'text'}
                  placeholder={s.secret && s.isSet ? '•••••• lagret' : ''}
                  value={values[s.key]}
                  onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" onClick={save}>
              Lagre
            </button>
          </div>
        </>
      )}
    </div>
  );
}
