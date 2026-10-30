/** Small controls shared by the shell and pages: theme switching and "sync now". */
import { useState } from 'react';
import { api } from '../api';
import { timeAgo } from '../format';
import { usePrefs, type Theme } from '../prefs';
import { useStore } from '../store';
import { Icon, haptic, useToast } from './ui';

/** One tap between light and dark (Innstillinger → Utseende has "follow the phone" too). */
export function ThemeToggle() {
  const { dark, set } = usePrefs();
  return (
    <button className="icon-btn" onClick={() => set({ theme: dark ? 'light' : 'dark' })} aria-label={dark ? 'Bytt til lyst tema' : 'Bytt til mørkt tema'} title={dark ? 'Lyst tema' : 'Mørkt tema'}>
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  );
}

export function ThemeSegment() {
  const { prefs, set } = usePrefs();
  const options: Array<{ id: Theme; label: string }> = [
    { id: 'system', label: 'Auto' },
    { id: 'light', label: 'Lyst' },
    { id: 'dark', label: 'Mørkt' },
  ];
  return (
    <div className="seg" role="radiogroup" aria-label="Tema">
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={prefs.theme === o.id} className={prefs.theme === o.id ? 'on' : ''} onClick={() => set({ theme: o.id })}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Fetch the newest transactions from all banks right now, instead of waiting for the 4-hour sync. */
export function SyncNow({ compact }: { compact?: boolean }) {
  const { summary, changed } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const last = summary?.accounts.map((a) => a.last_sync_at).filter(Boolean).sort().pop() ?? null;
  if (!summary?.accounts.some((a) => a.connection_id)) return null;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<Array<{ name: string; added?: number; error?: string }>>('/connections/sync-all');
      const added = r.reduce((s, x) => s + (x.added ?? 0), 0);
      const failed = r.filter((x) => x.error);
      haptic();
      toast(failed.length ? failed.map((f) => `${f.name}: ${f.error}`).join('; ') : added ? `${added} nye transaksjoner` : 'Alt er oppdatert', { error: failed.length > 0 });
      changed();
    } catch (e: any) {
      toast(e.message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  if (compact) {
    return (
      <button className={`icon-btn ${busy ? 'spinning' : ''}`} onClick={run} disabled={busy} aria-label="Synkroniser bankene nå" title="Synkroniser nå">
        <Icon name="sync" />
      </button>
    );
  }
  return (
    <button className="btn sync-btn" onClick={run} disabled={busy}>
      <span className={busy ? 'spinning' : ''} style={{ display: 'inline-flex' }}>
        <Icon name="sync" size={16} />
      </span>
      <span className="spacer" style={{ textAlign: 'left' }}>
        {busy ? 'Synkroniserer…' : 'Synkroniser nå'}
        <small className="faint" style={{ display: 'block', fontWeight: 400 }}>
          Sist {timeAgo(last)}
        </small>
      </span>
    </button>
  );
}

