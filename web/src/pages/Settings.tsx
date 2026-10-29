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

const TABS = ['Categories', 'Rules', 'Bank sync'] as const;

export default function SettingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Categories');
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <div className="seg">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === 'Categories' && <Categories />}
      {tab === 'Rules' && <Rules />}
      {tab === 'Bank sync' && <BankSync />}
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
        Rename by clicking a name. Hiding keeps the history but takes the category out of your way. Income categories feed “Ready to
        assign”.
      </p>
      {groups.map((g) => (
        <div key={g.id} className="card">
          <div className="list-item" style={{ background: 'var(--surface-2)', borderRadius: '12px 12px 0 0' }}>
            <InlineName value={g.name} onSave={(name) => patchGroup(g.id, { name })} bold />
            {g.is_income ? <span className="chip brand">Income</span> : null}
            <span className="spacer" />
            {!g.is_income && (
              <>
                <button className="icon-btn" onClick={() => patchGroup(g.id, { move: 'up' })} aria-label="Move group up">
                  <Icon name="up" size={16} />
                </button>
                <button className="icon-btn" onClick={() => patchGroup(g.id, { move: 'down' })} aria-label="Move group down">
                  <Icon name="down" size={16} />
                </button>
                <button className="icon-btn" onClick={() => patchGroup(g.id, { hidden: !g.hidden })} aria-label={g.hidden ? 'Show group' : 'Hide group'}>
                  <Icon name={g.hidden ? 'eyeOff' : 'eye'} size={16} />
                </button>
                {g.categories.length === 0 && (
                  <button
                    className="icon-btn"
                    aria-label="Delete group"
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
                aria-label="Move to group"
                onChange={(e) => patchCat(c.id, { group_id: Number(e.target.value) })}
              >
                {groups.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <button className="icon-btn" onClick={() => patchCat(c.id, { move: 'up' })} aria-label="Move up">
                <Icon name="up" size={16} />
              </button>
              <button className="icon-btn" onClick={() => patchCat(c.id, { move: 'down' })} aria-label="Move down">
                <Icon name="down" size={16} />
              </button>
              <button className="icon-btn" onClick={() => patchCat(c.id, { hidden: !c.hidden })} aria-label={c.hidden ? 'Show' : 'Hide'}>
                <Icon name={c.hidden ? 'eyeOff' : 'eye'} size={16} />
              </button>
              <button
                className="icon-btn"
                aria-label="Delete category"
                onClick={async () => {
                  const others = groups.flatMap((x) => x.categories).filter((x) => x.id !== c.id && !x.hidden);
                  const target = prompt(
                    `Delete “${c.name}”? Type the name of a category to move its transactions and money to (leave empty to make them uncategorized):\n\n${others.map((o) => o.name).join(', ')}`,
                  );
                  if (target === null) return;
                  const into = others.find((o) => o.name.toLowerCase() === target.trim().toLowerCase());
                  if (target.trim() && !into) return toast(`No category called “${target}”`, { error: true });
                  await api.del(`/categories/${c.id}${into ? `?reassign=${into.id}` : ''}`);
                  toast(into ? `Deleted. Everything moved to ${into.name}.` : 'Deleted');
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
        <input className="input" style={{ maxWidth: 280 }} placeholder="New group name" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
        <button className="btn">
          <Icon name="plus" size={16} /> Add group
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
      <input className="input" style={{ maxWidth: 280, minHeight: 32 }} placeholder="+ Add category" value={name} onChange={(e) => setName(e.target.value)} />
      {name && <button className="btn sm primary">Add</button>}
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
        Rules run on every new transaction, whether it came from a bank sync, a file or manual entry. Ticking “Always…” when reviewing
        creates one for you. Even without rules, the app learns from what you picked last time.
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
            toast('Rule added and applied to transactions waiting for review');
            await Promise.all([load(), refresh()]);
          } catch (err: any) {
            toast(err.message, { error: true });
          }
        }}
      >
        <h3 style={{ margin: 0 }}>New rule</h3>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '0 1 150px' }}>
            When text
            <select className="select" value={matchType} onChange={(e) => setMatchType(e.target.value as Rule['match_type'])}>
              <option value="contains">contains</option>
              <option value="starts">starts with</option>
              <option value="equals">is exactly</option>
            </select>
          </label>
          <label className="field" style={{ flex: '1 1 180px' }}>
            &nbsp;
            <input className="input" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. klatresenter" />
          </label>
          <label className="field" style={{ flex: '1 1 200px' }}>
            Put it in
            <CategorySelect categories={summary?.categories ?? []} value={categoryId} onChange={setCategoryId} placeholder="(don't change)" />
          </label>
          <label className="field" style={{ flex: '1 1 160px' }}>
            Rename payee to
            <input className="input" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder="(optional)" />
          </label>
          <button className="btn primary" disabled={!pattern.trim() || (!categoryId && !renameTo.trim())}>
            Add rule
          </button>
        </div>
      </form>
      <div className="card">
        {rules.length === 0 ? (
          <div className="empty">No rules yet.</div>
        ) : (
          <div className="list">
            {rules.map((r) => (
              <div key={r.id} className="list-item">
                <div className="grow">
                  Text {r.match_type === 'contains' ? 'contains' : r.match_type === 'starts' ? 'starts with' : 'is'} <strong>“{r.pattern}”</strong>
                  {r.category_name && (
                    <>
                      {' '}
                      → <span className="chip brand">{r.category_name}</span>
                    </>
                  )}
                  {r.rename_to && <> · rename to “{r.rename_to}”</>}
                  <div className="small faint">Used {r.hits} times</div>
                </div>
                <button
                  className="icon-btn"
                  aria-label="Delete rule"
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
          Norwegian banks share your transactions through open banking (PSD2), but only via a licensed provider. Set up one (or both) of
          these once. Then connecting a bank is just BankID. Your keys stay in your own database and are never shown again after
          saving.
        </div>
      </div>
      {data.providers.map((p) => (
        <ProviderCard key={p.id} p={p} onSaved={load} />
      ))}
      <div className="card card-pad small">
        <h3>Recommended setup for your banks</h3>
        <table className="table">
          <tbody>
            <tr>
              <td>SpareBank 1 Sør-Norge</td>
              <td>Enable Banking, or SpareBank 1 direct (free, made for personal use)</td>
            </tr>
            <tr>
              <td>DNB credit card</td>
              <td>Enable Banking</td>
            </tr>
            <tr>
              <td>Revolut</td>
              <td>Enable Banking (or CSV export from the app)</td>
            </tr>
            <tr>
              <td>TF Bank credit card</td>
              <td>Enable Banking if your card shows up in the list, otherwise CSV import or manual entry</td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          Banks require you to re-confirm with BankID about every 90–180 days. The app warns you a week before. Syncing runs automatically
          every 4 hours while the server is running.
          {!data.passwordEnabled && ' Tip: set APP_PASSWORD in .env before putting this on the internet.'}
        </p>
      </div>
    </div>
  );
}

const SETUP_STEPS: Record<string, (callback: string) => React.ReactNode> = {
  enablebanking: (callback) => (
    <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
      <li>
        Sign up at <a href="https://enablebanking.com/sign-in/" target="_blank" rel="noreferrer">enablebanking.com</a> (free for linking your
        own accounts).
      </li>
      <li>
        In the Control Panel → <em>Applications</em> → <em>Register new application</em>. Choose environment <strong>Production</strong>,
        and let it generate a private key in your browser. Save the .pem file.
      </li>
      <li>
        Add this as the redirect URL: <code style={{ userSelect: 'all' }}>{callback}</code>
      </li>
      <li>Activate the application by linking your own accounts (restricted mode). No company or contract needed.</li>
      <li>Paste the application ID and the contents of the .pem file below.</li>
    </ol>
  ),
  sparebank1: (callback) => (
    <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
      <li>
        Log in at <a href="https://developersparebank1.no" target="_blank" rel="noreferrer">developersparebank1.no</a> with BankID and open{' '}
        <em>Personlig klient</em>.
      </li>
      <li>
        Create a client with redirect URL <code style={{ userSelect: 'all' }}>{callback}</code>
      </li>
      <li>Copy the client ID and secret, and find your bank's ID (finInst) in the bank list on the same page.</li>
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
    toast(`${p.label} saved`);
    onSaved();
    setOpen(false);
  };
  return (
    <div className="card card-pad stack">
      <div className="row">
        <div className="spacer">
          <h3 style={{ margin: 0 }}>
            {p.label} {p.configured ? <span className="pill good small">Ready</span> : <span className="pill zero small">Not set up</span>}
          </h3>
          <div className="small muted">{p.description}</div>
        </div>
        <button className="btn sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : p.configured ? 'Change keys' : 'Set up'}
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
                <textarea
                  className="input"
                  rows={4}
                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                  placeholder={s.isSet ? '•••••• saved. Paste a new one to replace it' : '-----BEGIN PRIVATE KEY-----'}
                  value={values[s.key]}
                  onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
                />
              ) : (
                <input
                  className="input"
                  type={s.secret ? 'password' : 'text'}
                  placeholder={s.secret && s.isSet ? '•••••• saved' : ''}
                  value={values[s.key]}
                  onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
                />
              )}
            </label>
          ))}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" onClick={save}>
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}
