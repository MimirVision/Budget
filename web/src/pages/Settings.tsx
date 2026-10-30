import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { AppVersion } from '../version';
import { CategorySelect, Icon, Modal, Money, MoneyInput, useToast } from '../components/ui';
import { kr, monthLabel } from '../format';
import { addMonths, currentMonth, todayISO } from '../../../shared/months';
import { ACCENTS, usePrefs, type Theme } from '../prefs';

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

const TABS = ['Utseende', 'Budsjett', 'Kategorier', 'Regler', 'Banksynkronisering'] as const;

export default function SettingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Utseende');
  return (
    <>
      <div className="page-head">
        <h1>Innstillinger</h1>
        <div className="seg settings-tabs">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === 'Utseende' && <Appearance />}
      {tab === 'Budsjett' && <FreshStart />}
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
  const [deleting, setDeleting] = useState<{ id: number; name: string } | null>(null);
  const { summary } = useStore();
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
                onClick={() => setDeleting(c)}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
          <AddCategory groupId={g.id} onAdded={after} />
        </div>
      ))}
      {deleting && (
        <DeleteCategory
          cat={deleting}
          options={summary?.categories.filter((x) => x.id !== deleting.id && !x.hidden) ?? []}
          onClose={() => setDeleting(null)}
          onDone={(text) => {
            setDeleting(null);
            toast(text);
            after();
          }}
        />
      )}
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const { summary, refresh } = useStore();
  const clear = () => {
    setPattern('');
    setRenameTo('');
    setCategoryId(null);
    setMatchType('contains');
    setEditingId(null);
  };
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
            const body = { pattern, match_type: matchType, category_id: categoryId, rename_to: renameTo, apply_existing: true };
            if (editingId) await api.patch(`/rules/${editingId}`, body);
            else await api.post('/rules', body);
            toast(editingId ? 'Regelen er oppdatert' : 'Regelen er lagt til og brukt på transaksjoner som venter på gjennomgang');
            clear();
            await Promise.all([load(), refresh()]);
          } catch (err: any) {
            toast(err.message, { error: true });
          }
        }}
      >
        <h3 style={{ margin: 0 }}>{editingId ? 'Endre regel' : 'Ny regel'}</h3>
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
            {editingId ? 'Lagre endring' : 'Legg til regel'}
          </button>
          {editingId && (
            <button type="button" className="btn ghost" onClick={clear}>
              Avbryt
            </button>
          )}
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
                  aria-label="Endre regelen"
                  onClick={() => {
                    setEditingId(r.id);
                    setPattern(r.pattern);
                    setMatchType(r.match_type);
                    setCategoryId(r.category_id);
                    setRenameTo(r.rename_to ?? '');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  <Icon name="edit" size={16} />
                </button>
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
          kjører automatisk hver sjette time (fire ganger i døgnet, det bankene tillater uten at du er til stede). «Synkroniser nå» kan brukes når du vil.
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

function Appearance() {
  const { prefs, set } = usePrefs();
  const themes: Array<{ id: Theme; label: string; bg: string; fg: string; card: string }> = [
    { id: 'system', label: 'Følg enheten', bg: 'linear-gradient(90deg, #f6f6f3 50%, #121412 50%)', fg: '#9a9a94', card: '#ffffff' },
    { id: 'light', label: 'Lyst', bg: '#f6f6f3', fg: '#d6d6d0', card: '#ffffff' },
    { id: 'dark', label: 'Mørkt', bg: '#121412', fg: '#3a3f3c', card: '#1a1d1b' },
  ];
  const Toggle = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
    <button role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
  );
  return (
    <div className="stack">
      <div className="card card-pad">
        <h3>Tema</h3>
        <div className="theme-preview">
          {themes.map((t) => (
            <button key={t.id} className={`theme-card ${prefs.theme === t.id ? 'on' : ''}`} onClick={() => set({ theme: t.id })} aria-pressed={prefs.theme === t.id}>
              <div className="mock" style={{ background: t.bg }}>
                <span style={{ background: 'var(--brand)', width: '60%' }} />
                <span style={{ background: t.fg, width: '85%' }} />
                <span style={{ background: t.fg, width: '45%' }} />
              </div>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card card-pad">
        <h3>Aksentfarge</h3>
        <div className="accent-swatches" role="radiogroup" aria-label="Aksentfarge">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={prefs.accent === a.id}
              aria-label={a.label}
              title={a.label}
              className={`accent-swatch ${prefs.accent === a.id ? 'on' : ''}`}
              style={{ background: a.color }}
              onClick={() => set({ accent: a.id })}
            >
              {prefs.accent === a.id && <Icon name="check" size={18} />}
            </button>
          ))}
        </div>
      </div>

      <div className="card card-pad">
        <h3 style={{ marginBottom: 0 }}>Visning</h3>
        <div className="pref-row">
          <div className="grow">
            <strong>Kompakt</strong>
            <div className="small muted">Mindre luft, mer på skjermen.</div>
          </div>
          <Toggle label="Kompakt visning" on={prefs.density === 'compact'} onChange={(v) => set({ density: v ? 'compact' : 'comfortable' })} />
        </div>
        <div className="pref-row">
          <div className="grow">
            <strong>Vis øre</strong>
            <div className="small muted">Slå av for hele kroner: 1 235 kr i stedet for 1 234,56 kr.</div>
          </div>
          <Toggle label="Vis øre" on={prefs.showOre} onChange={(v) => set({ showOre: v })} />
        </div>
        <div className="pref-row">
          <div className="grow">
            <strong>Startside</strong>
            <div className="small muted">Hva som vises når du åpner appen.</div>
          </div>
          <div className="seg">
            <button className={prefs.start === 'budget' ? 'on' : ''} onClick={() => set({ start: 'budget' })}>
              Budsjett
            </button>
            <button className={prefs.start === 'overview' ? 'on' : ''} onClick={() => set({ start: 'overview' })}>
              Oversikt
            </button>
          </div>
        </div>
      </div>
      <p className="small faint" style={{ margin: 0 }}>
        Utseendet lagres på denne enheten, så telefonen og PC-en kan se forskjellige ut.
      </p>
      <AppVersion />
    </div>
  );
}

interface Opening {
  accountId: number;
  name: string;
  kind: string;
  onBudget: boolean;
  source: 'bank' | 'history';
  opening: number;
}

/** «Start på nytt»: begin the budget from a chosen month with today's real balances, nothing carried over. */
function FreshStart() {
  const { summary, changed } = useStore();
  const toast = useToast();
  // Late in the month, starting next month is the natural choice.
  const [month, setMonth] = useState(() => (Number(todayISO().slice(8, 10)) >= 20 ? addMonths(currentMonth(), 1) : currentMonth()));
  const [rows, setRows] = useState<Opening[] | null>(null);
  const [edits, setEdits] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const active = summary?.budgetStart ?? null;

  useEffect(() => {
    setRows(null);
    api.get<{ accounts: Opening[] }>(`/fresh-start/preview?month=${month}`).then((r) => setRows(r.accounts));
  }, [month, active]);

  const value = (r: Opening) => edits[r.accountId] ?? r.opening;
  const total = (rows ?? []).filter((r) => r.onBudget).reduce((s, r) => s + value(r), 0);
  const startLabel = `1. ${monthLabel(month).toLowerCase()}`;

  const apply = async () => {
    if (!confirm(`Starte budsjettet på nytt fra ${startLabel}?\n\nAlt før dette blir historikk og teller ikke lenger. Kategoriene starter tomme, og ${kr(total)} havner i «Klar til fordeling». Du kan angre.`)) return;
    setBusy(true);
    try {
      await api.post('/fresh-start', { month, overrides: edits });
      toast(`Budsjettet starter nå ${startLabel}. Gi pengene en jobb!`);
      setEdits({});
      changed();
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!confirm('Angre den nye starten? Budsjettet går tilbake til slik det var, med all historikk.')) return;
    await api.del('/fresh-start');
    toast('Ny start er angret');
    changed();
  };

  const setOverspending = async (mode: 'carry' | 'reset') => {
    await api.put('/settings', { overspending: mode === 'carry' ? null : mode });
    changed();
    toast(mode === 'reset' ? 'Overforbruk trekkes nå fra neste måneds Klar til fordeling' : 'Overforbruk følger nå med til neste måned');
  };
  const mode = summary?.overspending ?? 'carry';

  return (
    <div className="stack">
      <div className="card card-pad stack">
        <div>
          <h3 style={{ marginBottom: 4 }}>Overforbruk</h3>
          <p className="small muted" style={{ margin: 0 }}>Hva skjer når en kategori går i minus og måneden er over?</p>
        </div>
        <div className="option-grid">
          <button className={`option ${mode === 'carry' ? 'on' : ''}`} onClick={() => setOverspending('carry')} aria-pressed={mode === 'carry'}>
            <strong>Følger med kategorien</strong>
            <span className="small muted">Kategorien starter neste måned i minus, og du dekker det selv. Overforbruket blir ikke glemt.</span>
          </button>
          <button className={`option ${mode === 'reset' ? 'on' : ''}`} onClick={() => setOverspending('reset')} aria-pressed={mode === 'reset'}>
            <strong>Trekkes fra Klar til fordeling</strong>
            <span className="small muted">Som i YNAB: alle kategorier starter på 0 eller mer, og overforbruket tas fra neste måneds penger.</span>
          </button>
        </div>
      </div>

      {active && (
        <div className="callout good">
          <Icon name="check" size={20} />
          <div className="grow" style={{ flex: 1 }}>
            <strong>Budsjettet startet {`1. ${monthLabel(active.slice(0, 7)).toLowerCase()}`}.</strong>
            <div className="small">Alt før det er historikk. Saldoene følger banken de første dagene, så sene bokføringer fra før start ikke forstyrrer.</div>
          </div>
          <button className="btn sm" onClick={undo}>
            Angre
          </button>
        </div>
      )}

      <div className="card card-pad stack">
        <div>
          <h3 style={{ marginBottom: 4 }}>{active ? 'Start på nytt igjen' : 'Start på nytt'}</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Rot i gamle tall, for eksempel overføringer som ble registrert som inntekt eller et kort uten historikk? Start budsjettet fra en ny
            måned. Hver konto starter med saldoen fra banken, pengene havner i «Klar til fordeling», og kategoriene starter tomme. Gamle
            transaksjoner blir liggende som historikk.
          </p>
        </div>
        <label className="field" style={{ maxWidth: 240 }}>
          Start fra
          <select className="select" value={month} onChange={(e) => (setMonth(e.target.value), setEdits({}))}>
            {[-2, -1, 0, 1].map((n) => {
              const m = addMonths(currentMonth(), n);
              return (
                <option key={m} value={m}>
                  1. {monthLabel(m).toLowerCase()}
                </option>
              );
            })}
          </select>
        </label>

        <div className="card list">
          {rows === null ? (
            <div className="list-item muted">Henter saldoer…</div>
          ) : (
            rows.map((r) => (
              <div key={r.accountId} className="list-item" style={{ flexWrap: 'wrap' }}>
                <div className="grow" style={{ minWidth: 150 }}>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  <div className="small faint">
                    {r.source === 'bank' ? 'Fra banken' : 'Ingen synk: sjekk og skriv inn saldoen'}
                    {!r.onBudget && ' · oppfølging'}
                  </div>
                </div>
                <div style={{ width: 150 }}>
                  <MoneyInput
                    value={value(r)}
                    onCommit={(v) => setEdits((e) => ({ ...e, [r.accountId]: v }))}
                    ariaLabel={`Startsaldo for ${r.name}`}
                  />
                  {(r.kind === 'credit' || r.kind === 'loan') && <div className="small faint" style={{ textAlign: 'right' }}>gjeld skrives med minus</div>}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="row">
          <div className="spacer">
            <div className="small muted">Klar til fordeling blir</div>
            <strong style={{ fontSize: 20 }}>
              <Money value={total} />
            </strong>
          </div>
          <button className="btn primary" disabled={busy || rows === null} onClick={apply}>
            Start på nytt fra {startLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Delete a category, choosing where its transactions and money go instead of typing a name. */
function DeleteCategory({
  cat,
  options,
  onClose,
  onDone,
}: {
  cat: { id: number; name: string };
  options: Array<{ id: number; name: string; group_name: string; is_income: number }>;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const [target, setTarget] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    api.get<{ total: number }>(`/transactions?category=${cat.id}&limit=1`).then((r) => setCount(r.total));
  }, [cat.id]);
  const into = options.find((o) => o.id === target);
  return (
    <Modal
      title={`Slette «${cat.name}»?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Avbryt
          </button>
          <button
            className="btn primary danger-fill"
            onClick={async () => {
              await api.del(`/categories/${cat.id}${target ? `?reassign=${target}` : ''}`);
              onDone(into ? `Slettet. Alt er flyttet til ${into.name}.` : `«${cat.name}» er slettet`);
            }}
          >
            Slett kategorien
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        {count === null ? 'Teller transaksjoner…' : count === 0 ? 'Kategorien har ingen transaksjoner.' : `Kategorien har ${count} transaksjoner.`} Hvor skal de, og
        pengene som er fordelt hit, flyttes?
      </p>
      <label className="field">
        Flytt til
        <CategorySelect
          categories={options as any}
          value={target}
          onChange={setTarget}
          placeholder="Ingen: gjør dem ukategoriserte"
        />
      </label>
      {!target && count !== 0 && <div className="small faint">Transaksjonene havner i Gjennomgå igjen, så du kan gi dem en ny kategori.</div>}
    </Modal>
  );
}
