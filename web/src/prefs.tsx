/**
 * Look and feel, saved per device (a phone and a PC can look different): theme, accent colour, density,
 * start page and whether to show øre.
 */
import { Fragment, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { setShowOre } from './format';

export type Theme = 'system' | 'light' | 'dark';
export type Accent = 'green' | 'blue' | 'purple' | 'orange' | 'pink';
export interface Prefs {
  theme: Theme;
  accent: Accent;
  density: 'comfortable' | 'compact';
  start: 'budget' | 'overview';
  showOre: boolean;
}

export const ACCENTS: Array<{ id: Accent; label: string; color: string }> = [
  { id: 'green', label: 'Grønn', color: '#0f766e' },
  { id: 'blue', label: 'Blå', color: '#2563eb' },
  { id: 'purple', label: 'Lilla', color: '#7c3aed' },
  { id: 'orange', label: 'Oransje', color: '#c2410c' },
  { id: 'pink', label: 'Rosa', color: '#be185d' },
];

const DEFAULTS: Prefs = { theme: 'system', accent: 'green', density: 'comfortable', start: 'budget', showOre: true };
const KEY = 'budget.prefs';

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

const Ctx = createContext<{ prefs: Prefs; set: (p: Partial<Prefs>) => void; dark: boolean }>({
  prefs: DEFAULTS,
  set: () => {},
  dark: false,
});

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(load);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark);
  setShowOre(prefs.showOre);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = dark ? 'dark' : 'light';
    r.dataset.accent = prefs.accent;
    r.dataset.density = prefs.density;
    // Match the phone's status bar to the app background.
    const bg = getComputedStyle(r).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || (dark ? '#121412' : '#f6f6f3'));
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // Storage blocked: the choice lasts until the page is closed.
    }
  }, [prefs, dark]);

  return (
    <Ctx.Provider value={{ prefs, dark, set: (p) => setPrefs((old) => ({ ...old, ...p })) }}>
      {/* Amounts are formatted outside React state, so redraw everything when the øre setting changes. */}
      <Fragment key={String(prefs.showOre)}>{children}</Fragment>
    </Ctx.Provider>
  );
}

export const usePrefs = () => useContext(Ctx);
