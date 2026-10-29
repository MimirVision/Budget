import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { api } from './api';
import { StoreProvider, useStore } from './store';
import { Icon, Money, ToastProvider } from './components/ui';
import BudgetPage from './pages/Budget';
import ReviewPage from './pages/Review';
import TransactionsPage from './pages/Transactions';
import AccountsPage from './pages/Accounts';
import ReportsPage from './pages/Reports';
import SettingsPage from './pages/Settings';

const NAV = [
  { to: '/', label: 'Budsjett', icon: 'budget', end: true },
  { to: '/review', label: 'Gjennomgå', icon: 'inbox' },
  { to: '/transactions', label: 'Transaksjoner', icon: 'list' },
  { to: '/accounts', label: 'Kontoer', icon: 'bank' },
  { to: '/reports', label: 'Rapporter', icon: 'chart' },
  { to: '/settings', label: 'Innstillinger', icon: 'settings' },
];

function Layout() {
  const { summary } = useStore();
  const open = summary?.accounts.filter((a) => !a.closed) ?? [];
  const groups = [
    { label: 'Budsjettkontoer', items: open.filter((a) => a.on_budget) },
    { label: 'Oppfølging', items: open.filter((a) => !a.on_budget) },
  ].filter((g) => g.items.length);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.svg" alt="" /> Budsjett
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon name={n.icon} className="nav-icon" />
            {n.label}
            {n.to === '/review' && !!summary?.unreviewed && <span className="badge">{summary.unreviewed}</span>}
          </NavLink>
        ))}
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
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<BudgetPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      <nav className="bottom-nav">
        {NAV.filter((n) => n.to !== '/settings').map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name={n.icon} />
            {n.label}
            {n.to === '/review' && !!summary?.unreviewed && <span className="badge">{summary.unreviewed}</span>}
          </NavLink>
        ))}
      </nav>
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
