/**
 * Phone app shell: a compact title bar that fades in when the big page title scrolls away (as in iOS apps),
 * a back button on pages under "Mer", pull-to-refresh, and a soft transition between pages.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useStore } from './store';
import { Icon, haptic, useToast } from './components/ui';

const TITLES: Record<string, { title: string; sub?: boolean }> = {
  '/': { title: 'Budsjett' },
  '/oversikt': { title: 'Oversikt' },
  '/review': { title: 'Gjennomgå' },
  '/transactions': { title: 'Transaksjoner' },
  '/bills': { title: 'Faste regninger', sub: true },
  '/accounts': { title: 'Kontoer', sub: true },
  '/settings': { title: 'Innstillinger', sub: true },
  '/duplicates': { title: 'Duplikater', sub: true },
};

/** The bar at the top. Shows the page name once you've scrolled past the big title. */
export function TopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const page = TITLES[location.pathname] ?? { title: 'Budsjett' };

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 44);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [location.pathname]);

  return (
    <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
      <div className="topbar-side">
        {page.sub && (
          <button className="topbar-back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))} aria-label="Tilbake">
            <Icon name="left" size={22} />
            <span>Tilbake</span>
          </button>
        )}
      </div>
      <div className="topbar-title" aria-hidden={!scrolled}>
        {page.title}
      </div>
      <div className="topbar-side right" />
    </header>
  );
}

/**
 * Pull down at the top of a page to sync the banks (or just reload, if no bank is connected).
 * Built by hand because a home-screen app on iPhone has no pull-to-refresh of its own.
 */
export function PullToRefresh() {
  const { summary, changed } = useStore();
  const toast = useToast();
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  const pullRef = useRef(0);
  const busyRef = useRef(false);
  const THRESHOLD = 72;
  const hasBank = !!summary?.accounts.some((a) => a.connection_id);

  useEffect(() => {
    const down = (e: TouchEvent) => {
      // Only from the very top, and not inside a bottom sheet or a sideways scroller.
      if (busyRef.current || window.scrollY > 0 || (e.target as HTMLElement).closest('.modal-back, [data-no-ptr]')) return;
      start.current = e.touches[0].clientY;
    };
    const move = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = e.touches[0].clientY - start.current;
      if (dy <= 0 || window.scrollY > 0) {
        start.current = null;
        pullRef.current = 0;
        setPull(0);
        return;
      }
      // Resistance, like a rubber band.
      const d = Math.min(120, dy * 0.5);
      if (pullRef.current < THRESHOLD && d >= THRESHOLD) haptic(8);
      pullRef.current = d;
      setPull(d);
    };
    const up = async () => {
      if (start.current === null) return;
      start.current = null;
      const d = pullRef.current;
      pullRef.current = 0;
      if (d < THRESHOLD) {
        setPull(0);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setPull(THRESHOLD);
      try {
        if (hasBank) {
          const r = await api.post<Array<{ name: string; added?: number; error?: string }>>('/connections/sync-all');
          const added = r.reduce((s, x) => s + (x.added ?? 0), 0);
          const failed = r.filter((x) => x.error);
          toast(failed.length ? failed.map((f) => `${f.name}: ${f.error}`).join('; ') : added ? `${added} nye transaksjoner` : 'Alt er oppdatert', {
            error: failed.length > 0,
          });
        }
        changed();
      } catch (err: any) {
        toast(err.message, { error: true });
      } finally {
        busyRef.current = false;
        setBusy(false);
        setPull(0);
      }
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
  }, [hasBank, changed, toast]);

  if (!pull && !busy) return null;
  const ready = pull >= THRESHOLD;
  return (
    <div className="ptr" style={{ transform: `translateY(${pull - 40}px)`, opacity: Math.min(1, pull / 40) }} aria-live="polite">
      <span className={`ptr-spinner ${busy ? 'spinning' : ''}`} style={{ transform: busy ? undefined : `rotate(${pull * 3}deg)` }}>
        <Icon name="sync" size={18} />
      </span>
      <span className="ptr-text">{busy ? (hasBank ? 'Synkroniserer…' : 'Oppdaterer…') : ready ? 'Slipp for å oppdatere' : 'Dra for å oppdatere'}</span>
    </div>
  );
}

/** A soft fade-and-rise when you change page, so taps feel like they land somewhere. */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <div key={location.pathname} className="page-enter">
      {children}
    </div>
  );
}
