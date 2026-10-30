import { useEffect, useState } from 'react';

const PHONE = '(max-width: 860px)';

/** True on phone-sized screens. Pages render a dedicated phone layout instead of squeezing the desktop one. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const on = () => setMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

/** useState that remembers its value in this browser (e.g. collapsed groups). Falls back silently if storage is blocked. */
export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private mode or blocked storage: keep it in memory only.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
