import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Summary } from './api';

interface Store {
  summary: Summary | null;
  refresh: () => Promise<void>;
}

const StoreContext = createContext<Store>({ summary: null, refresh: async () => {} });

/** Shared data every page needs: accounts, categories, inbox count. Pages call refresh() after changes. */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const refresh = useCallback(async () => {
    setSummary(await api.get<Summary>('/summary'));
  }, []);
  useEffect(() => {
    refresh().catch(() => undefined);
    const onFocus = () => refresh().catch(() => undefined);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  return <StoreContext.Provider value={{ summary, refresh }}>{children}</StoreContext.Provider>;
}

export const useStore = () => useContext(StoreContext);
