import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { kr, parseMoney, toInput } from '../format';
import type { CategoryOption } from '../api';

// ---------- Icons (inline, so the app has no icon dependency) ----------
const paths: Record<string, string> = {
  budget: 'M4 6h16M4 12h16M4 18h10',
  inbox: 'M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  bank: 'M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  plus: 'M12 5v14M5 12h14',
  close: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  sync: 'M21 12a9 9 0 01-15.5 6.2L3 16M3 12a9 9 0 0115.5-6.2L21 8M21 3v5h-5M3 21v-5h5',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  swap: 'M7 16l-4-4 4-4M3 12h14M17 8l4 4-4 4',
  split: 'M6 3v6a6 6 0 006 6h0a6 6 0 006-6V3M12 15v6',
  magic: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  up: 'M18 15l-6-6-6 6',
  down: 'M6 9l6 6 6-6',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M17.9 17.9A10 10 0 0112 20c-7 0-11-8-11-8a18 18 0 015.1-5.9M9.9 4.2A9 9 0 0112 4c7 0 11 8 11 8a18 18 0 01-2.2 3.2M1 1l22 22',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  calendar: 'M3 6h18v15H3zM16 3v4M8 3v4M3 10h18',
  wallet: 'M20 7H5a2 2 0 010-4h13v4M3 5v14a2 2 0 002 2h15v-5M20 12h-4a2 2 0 000 4h4z',
  pie: 'M21.2 15.9A10 10 0 118 2.8M22 12A10 10 0 0012 2v10z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  filter: 'M3 5h18M6 12h12M10 19h4',
  clip: 'M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
};

export function Icon({ name, size = 20, className = '' }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

// ---------- Money ----------
export function Money({ value, sign, className = '' }: { value: number; sign?: boolean; className?: string }) {
  return <span className={`num ${value > 0 && sign ? 'amount-in' : ''} ${className}`}>{kr(value, { sign })}</span>;
}

/** Text input for kroner. Accepts "1 500", "1500,50" and maths like "1200+300". Commits on blur/Enter. */
export function MoneyInput({
  value,
  onCommit,
  className = 'input',
  placeholder = '0',
  autoFocus,
  ariaLabel,
  disabled,
}: {
  value: number;
  onCommit: (ore: number) => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(toInput(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(toInput(value));
  }, [value, focused]);
  const commit = () => {
    const parsed = parseMoney(text);
    if (parsed === null) {
      setText(toInput(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
    setText(toInput(parsed));
  };
  return (
    <input
      className={`${className} num`}
      inputMode="decimal"
      value={focused ? text : value ? kr(value).replace(' kr', '') : ''}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      disabled={disabled}
      title={disabled ? 'Måneden er før budsjettet startet, og kan ikke endres' : undefined}
      onFocus={(e) => {
        setFocused(true);
        setText(toInput(value));
        requestAnimationFrame(() => e.target.select());
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(toInput(value));
          setFocused(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// ---------- Category select (native select: great on phones) ----------
export function CategorySelect({
  categories,
  value,
  onChange,
  amount,
  placeholder = 'Velg kategori…',
  className = 'select',
  extra,
}: {
  categories: CategoryOption[];
  value: number | string | null;
  onChange: (id: number | null) => void;
  amount?: number;
  placeholder?: string;
  className?: string;
  extra?: ReactNode;
}) {
  const visible = categories.filter((c) => !c.hidden || c.id === value);
  // Show income categories first for money coming in, last for money going out.
  const groups = new Map<string, CategoryOption[]>();
  const sorted = [...visible].sort((a, b) => {
    if (a.is_income !== b.is_income) return amount !== undefined && amount > 0 ? b.is_income - a.is_income : a.is_income - b.is_income;
    return 0;
  });
  for (const c of sorted) groups.set(c.group_name, [...(groups.get(c.group_name) ?? []), c]);
  return (
    <select className={className} value={value ?? ''} onChange={(e) => {
        const v = e.target.value;
        // Non-numeric values come from `extra` options (e.g. "none"); pass them through untouched.
        onChange(v === '' ? null : Number.isNaN(Number(v)) ? (v as unknown as number) : Number(v));
      }}>
      <option value="">{placeholder}</option>
      {[...groups].map(([group, cats]) => (
        <optgroup key={group} label={cats[0].is_income ? `${group} → Klar til fordeling` : group}>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      ))}
      {extra}
    </select>
  );
}

// ---------- Modal ----------
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Don't let the page behind scroll while a sheet is open.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  // On phones the dialog is a bottom sheet: drag it down by its top to close it.
  const [dy, setDy] = useState(0);
  const startY = useRef<number | null>(null);
  const grab = {
    onPointerDown: (e: React.PointerEvent) => {
      if (!window.matchMedia('(max-width: 860px)').matches || (e.target as HTMLElement).closest('button')) return;
      startY.current = e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (startY.current !== null) setDy(Math.max(0, e.clientY - startY.current));
    },
    onPointerUp: () => {
      if (startY.current === null) return;
      startY.current = null;
      if (dy > 90) onClose();
      else setDy(0);
    },
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal ${wide ? 'wide' : ''} ${startY.current !== null ? 'dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
      >
        <div className="sheet-grab" {...grab} onPointerCancel={grab.onPointerUp}>
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Lukk">
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
interface Toast {
  id: number;
  text: string;
  error?: boolean;
  action?: { label: string; run: () => void };
}
const ToastContext = createContext<(text: string, opts?: { error?: boolean; action?: Toast['action'] }) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, opts: { error?: boolean; action?: Toast['action'] } = {}) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, text, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.error ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            <span style={{ flex: 1 }}>{t.text}</span>
            {t.action && (
              <button
                className="btn sm"
                onClick={() => {
                  t.action!.run();
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function Availability({ value, needed = 0 }: { value: number; needed?: number }) {
  const cls = value < 0 ? 'bad' : needed > 0 ? 'warn' : value > 0 ? 'good' : 'zero';
  return <span className={`pill ${cls} num`}>{kr(value)}</span>;
}

/** Counts smoothly from the previous value to the new one. Small, but it makes changes feel alive. */
export function AnimatedMoney({ value, className = '' }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    if (a === value || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      from.current = value;
      return;
    }
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / 450);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value]);
  return <span className={`num ${className}`}>{kr(shown)}</span>;
}

/** A tiny vibration on phones that support it: a physical "done" for approving and assigning. */
export function haptic(ms = 12) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Not supported; that's fine.
  }
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Laster">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - (i % 3) * 15}%` }} />
      ))}
    </div>
  );
}
