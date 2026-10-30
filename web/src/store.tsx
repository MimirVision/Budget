import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Summary } from './api';

interface Store {
  summary: Summary | null;
  refresh: () => Promise<void>;
  /** Bumped whenever data changes somewhere else (e.g. the quick-add button), so open pages reload. */
  version: number;
  changed: () => void;
}

const StoreContext = createContext<Store>({ summary: null, refresh: async () => {}, version: 0, changed: () => {} });

/** Shared data every page needs: accounts, categories, inbox count. Pages call refresh() after changes. */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(async () => {
    setSummary(await api.get<Summary>('/summary'));
  }, []);
  useEffect(() => {
    refresh().catch(() => undefined);
    const onFocus = () => refresh().catch(() => undefined);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    refresh().catch(() => undefined);
  }, [refresh]);
  return <StoreContext.Provider value={{ summary, refresh, version, changed }}>{children}</StoreContext.Provider>;
}

export const useStore = () => useContext(StoreContext);
