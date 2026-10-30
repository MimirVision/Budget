import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { api } from './api';
import { StoreProvider, useStore } from './store';
import { AnimatedMoney, Icon, Modal, Money, ToastProvider, haptic } from './components/ui';
import { TransactionEditor } from './components/TransactionEditor';
import { useIsMobile } from './hooks';
import BudgetPage from './pages/Budget';
import ReviewPage from './pages/Review';
import TransactionsPage from './pages/Transactions';
import AccountsPage from './pages/Accounts';
import OverviewPage from './pages/Overview';
import SettingsPage from './pages/Settings';

const PRIMARY = [
  { to: '/', label: 'Budsjett', icon: 'wallet', end: true, hint: 'Planlegg pengene' },
  { to: '/oversikt', label: 'Oversikt', icon: 'pie', hint: 'Se hvor de gikk' },
];
const SECONDARY = [
  { to: '/review', label: 'Gjennomgå', icon: 'inbox' },
  { to: '/transactions', label: 'Transaksjoner', icon: 'list' },
  { to: '/accounts', label: 'Kontoer', icon: 'bank' },
];

function Layout() {
  const { summary, changed } = useStore();
  const mobile = useIsMobile();
  const [adding, setAdding] = useState(false);
  const [more, setMore] = useState(false);
  const location = useLocation();
  useEffect(() => setMore(false), [location.pathname, location.search]);

  const open = summary?.accounts.filter((a) => !a.closed) ?? [];
  const groups = [
    { label: 'Budsjettkontoer', items: open.filter((a) => a.on_budget) },
    { label: 'Oppfølging', items: open.filter((a) => !a.on_budget) },
  ].filter((g) => g.items.length);
  const badge = summary?.unreviewed ? <span className="badge">{summary.unreviewed}</span> : null;
  const rta = summary?.readyToAssign ?? 0;

  return (
    <div className="app">
      {!mobile && (
        <aside className="sidebar">
          <div className="brand">
            <img src="/icon.svg" alt="" /> Budsjett
          </div>
          <button className="btn primary side-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Ny transaksjon
          </button>
          {PRIMARY.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link primary-link ${isActive ? 'active' : ''}`}>
              <Icon name={n.icon} className="nav-icon" />
              <span>
                {n.label}
                <small>{n.hint}</small>
              </span>
            </NavLink>
          ))}
          <div className="side-divider" />
          {SECONDARY.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <Icon name={n.icon} className="nav-icon" />
              {n.label}
              {n.to === '/review' && badge}
            </NavLink>
          ))}
          {summary && (
            <NavLink to="/" className={`side-rta ${rta > 0 ? 'positive' : rta < 0 ? 'negative' : ''}`}>
              <span className="small">Klar til fordeling</span>
              <AnimatedMoney value={rta} />
            </NavLink>
          )}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="side-section">{g.label}</div>
              {g.items.map((a) => (
                <NavLink key={a.id} to={`/transactions?account=${a.id}`} className="side-account">
                  <span>{a.name}</span>
                  <Money value={a.balance} className={a.balance < 0 ? 'faint' : ''} />
                </NavLink>
              ))}
            </div>
          ))}
          <div className="spacer" />
          <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon name="settings" className="nav-icon" />
            Innstillinger
          </NavLink>
        </aside>
      )}
      <main className="main">
        <Routes>
          <Route path="/" element={<BudgetPage />} />
          <Route path="/oversikt" element={<OverviewPage />} />
          <Route path="/reports" element={<Navigate to="/oversikt" replace />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      {mobile && (
        <nav className="tabbar" aria-label="Hovedmeny">
          {PRIMARY.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon name={n.icon} />
              {n.label}
            </NavLink>
          ))}
          <button className="fab" onClick={() => setAdding(true)} aria-label="Ny transaksjon">
            <Icon name="plus" size={26} />
          </button>
          <NavLink to="/review" className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name="inbox" />
            Gjennomgå
            {badge}
          </NavLink>
          <button className={more ? 'active' : ''} onClick={() => setMore(true)}>
            <Icon name="more" />
            Mer
          </button>
        </nav>
      )}
      {more && (
        <Modal title="Mer" onClose={() => setMore(false)}>
          <div className="more-grid">
            {[...SECONDARY.slice(1), { to: '/settings', label: 'Innstillinger', icon: 'settings' }].map((n) => (
              <Link key={n.to} to={n.to} className="more-tile">
                <Icon name={n.icon} size={24} />
                {n.label}
              </Link>
            ))}
          </div>
          {groups.map((g) => (
            <div key={g.label}>
              <div className="side-section" style={{ padding: '0 0 4px' }}>{g.label}</div>
              <div className="card list">
                {g.items.map((a) => (
                  <Link key={a.id} to={`/transactions?account=${a.id}`} className="list-item" style={{ color: 'var(--text)', textDecoration: 'none' }}>
                    <span className="grow ellipsis">{a.name}</span>
                    <Money value={a.balance} />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </Modal>
      )}
      {adding && (
        <TransactionEditor
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            haptic();
            changed();
          }}
        />
      )}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="login">
      <form
        className="card card-pad stack"
        style={{ width: 'min(360px, 100%)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post('/auth/login', { password });
            onDone();
          } catch (err: any) {
            setError(err.message);
          }
        }}
      >
        <div className="brand" style={{ padding: 0 }}>
          <img src="/icon.svg" alt="" /> Budsjett
        </div>
        <label className="field">
          Passord for husstanden
          <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="callout bad small">{error}</div>}
        <button className="btn primary">Logg inn</button>
      </form>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState<'checking' | 'in' | 'out'>('checking');
  useEffect(() => {
    const check = () =>
      api
        .get<{ loggedIn: boolean }>('/auth/status')
        .then((s) => setAuth(s.loggedIn ? 'in' : 'out'))
        .catch(() => setAuth('in'));
    check();
    const onLogout = () => setAuth('out');
    window.addEventListener('budget:logout', onLogout);
    return () => window.removeEventListener('budget:logout', onLogout);
  }, []);
  if (auth === 'checking') return null;
  if (auth === 'out') return <Login onDone={() => setAuth('in')} />;
  return (
    <StoreProvider>
      <Layout />
    </StoreProvider>
  );
}

// SpareBank 1 sends you back to the front page after BankID; hand the code over to the API to finish connecting.
const params = new URLSearchParams(window.location.search);
if (window.location.pathname === '/' && params.has('state') && (params.has('code') || params.has('error'))) {
  window.location.replace(`/api/connections/callback${window.location.search}`);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
