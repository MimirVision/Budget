/**
 * Ctrl+K (⌘K on Mac): jump anywhere by typing. Pages, categories, accounts, actions, and transactions found by
 * search, all from the keyboard.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Transaction } from './api';
import { dayLabel, kr } from './format';
import { useStore } from './store';
import { Icon } from './components/ui';

interface Item {
  key: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function CommandPalette({ onAdd, onSync }: { onAdd: () => void; onSync: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<Transaction[]>([]);
  const navigate = useNavigate();
  const { summary } = useStore();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('budget:palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('budget:palette', onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setFound([]);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);
  // Transactions: searched on the server, a moment after you stop typing.
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => {
      api
        .get<{ transactions: Transaction[] }>(`/transactions?q=${encodeURIComponent(q.trim())}&limit=6`)
        .then((r) => setFound(r.transactions))
        .catch(() => setFound([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const go = (to: string) => () => {
    setOpen(false);
    navigate(to);
  };
  const items = useMemo<Item[]>(() => {
    const pages: Item[] = [
      { key: 'p-budget', label: 'Budsjett', icon: 'wallet', run: go('/') },
      { key: 'p-overview', label: 'Oversikt', icon: 'pie', run: go('/oversikt') },
      { key: 'p-review', label: 'Gjennomgå', icon: 'inbox', run: go('/review') },
      { key: 'p-tx', label: 'Transaksjoner', icon: 'list', run: go('/transactions') },
      { key: 'p-bills', label: 'Faste regninger', icon: 'calendar', run: go('/bills') },
      { key: 'p-cards', label: 'Kredittkort', icon: 'wallet', run: go('/cards') },
      { key: 'p-acc', label: 'Kontoer', icon: 'bank', run: go('/accounts') },
      { key: 'p-set', label: 'Innstillinger', icon: 'settings', run: go('/settings') },
      { key: 'p-dup', label: 'Duplikater', icon: 'alert', run: go('/duplicates') },
      { key: 'a-add', label: 'Legg til transaksjon', hint: 'Handling', icon: 'plus', run: () => (setOpen(false), onAdd()) },
      { key: 'a-sync', label: 'Synkroniser bankene nå', hint: 'Handling', icon: 'sync', run: () => (setOpen(false), onSync()) },
    ];
    const cats: Item[] = (summary?.categories ?? [])
      .filter((c) => !c.hidden)
      .map((c) => ({ key: `c-${c.id}`, label: c.name, hint: `Kategori · ${c.group_name}`, icon: 'pie', run: go(`/transactions?category=${c.id}`) }));
    const accs: Item[] = (summary?.accounts ?? [])
      .filter((a) => !a.closed)
      .map((a) => ({ key: `a-${a.id}`, label: a.name, hint: `Konto · ${kr(a.balance)}`, icon: 'bank', run: go(`/transactions?account=${a.id}`) }));
    const needle = norm(q.trim());
    const all = [...pages, ...cats, ...accs];
    const matched = needle
      ? all
          .filter((i) => norm(i.label).includes(needle))
          .sort((a, b) => Number(!norm(b.label).startsWith(needle)) - Number(!norm(a.label).startsWith(needle)))
      : pages;
    const txs: Item[] = found.map((t) => ({
      key: `t-${t.id}`,
      label: t.payee || t.raw_description,
      hint: `${dayLabel(t.date)} · ${kr(t.amount)} · ${t.account_name}`,
      icon: 'list',
      run: go(`/transactions?q=${encodeURIComponent(q.trim())}`),
    }));
    const searchAll: Item[] = needle
      ? [{ key: 's-all', label: `Søk etter «${q.trim()}» i alle transaksjoner`, icon: 'search', run: go(`/transactions?q=${encodeURIComponent(q.trim())}`) }]
      : [];
    return [...matched.slice(0, 8), ...txs, ...searchAll];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, found, summary]);
  useEffect(() => setActive(0), [q, found]);

  if (!open) return null;
  return (
    <div className="palette-back" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Hurtigsøk">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={q}
            placeholder="Søk etter side, kategori, konto eller kjøp…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              else if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(items.length - 1, a + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
              else if (e.key === 'Enter') items[active]?.run();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" role="listbox">
          {items.length === 0 && <div className="palette-empty small muted">Ingen treff</div>}
          {items.map((i, n) => (
            <button
              key={i.key}
              role="option"
              aria-selected={n === active}
              className={`palette-item ${n === active ? 'on' : ''}`}
              onMouseEnter={() => setActive(n)}
              onClick={i.run}
            >
              <Icon name={i.icon} size={16} />
              <span className="grow ellipsis">{i.label}</span>
              {i.hint && <span className="small faint ellipsis palette-hint">{i.hint}</span>}
            </button>
          ))}
        </div>
        <div className="palette-foot small faint">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> velg
          </span>
          <span>
            <kbd>Enter</kbd> åpne
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>K</kbd> åpne/lukk
          </span>
        </div>
      </div>
    </div>
  );
}
