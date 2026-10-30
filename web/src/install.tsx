/**
 * Install as an app: on a PC (Chrome or Edge) or Android the browser offers to install the app, and this
 * catches that offer so the app can show its own "Installer appen" button. On iPhone it's Share → Add to Home Screen.
 */
import { useEffect, useState } from 'react';
import { Icon, useToast } from './components/ui';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // Keep the offer for our own button instead of the browser's banner.
    deferred = e as InstallPrompt;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
  // Only in a real build: in development a service worker would serve stale files.
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** A button that installs the app, shown only when the browser can actually do it. */
export function InstallButton({ className = 'btn ghost side-add' }: { className?: string }) {
  const [, setTick] = useState(0);
  const toast = useToast();
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  if (!deferred || installed()) return null;
  return (
    <button
      className={className}
      onClick={async () => {
        const p = deferred;
        if (!p) return;
        await p.prompt();
        const { outcome } = await p.userChoice;
        deferred = null;
        notify();
        if (outcome === 'accepted') toast('Budsjett er installert. Du finner den i Start-menyen og på skrivebordet.');
      }}
    >
      <Icon name="upload" size={16} /> Installer appen
    </button>
  );
}
