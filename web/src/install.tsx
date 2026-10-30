/**
 * Install as an app: on a PC (Chrome or Edge) or Android the browser offers to install the app, and this
 * catches that offer so the app can show its own "Installer appen" button. On iPhone it's Share → Add to Home Screen.
 */
import { useEffect, useState } from 'react';
import { Icon, Modal, useToast } from './components/ui';

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

type Browser = 'edge' | 'chrome' | 'firefox' | 'safari' | 'other';
function browser(): Browser {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/** Step by step for the browser in use, for when it hasn't handed us its install offer. */
function HowToInstall({ onClose }: { onClose: () => void }) {
  const b = browser();
  return (
    <Modal title="Installer Budsjett som app" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>OK</button>}>
      {b === 'chrome' && (
        <ol className="install-steps">
          <li>
            Se etter installer-ikonet helt til høyre i adressefeltet (en skjerm med en pil ned), og klikk på det.
          </li>
          <li>
            Ser du det ikke: klikk <strong>⋮</strong> øverst til høyre → <strong>Caste, lagre og dele</strong> →{' '}
            <strong>Installer side som app…</strong>
          </li>
          <li>Klikk <strong>Installer</strong>. Appen åpnes i eget vindu og legges i Start-menyen.</li>
        </ol>
      )}
      {b === 'edge' && (
        <ol className="install-steps">
          <li>Se etter installer-ikonet til høyre i adressefeltet (tre ruter og et pluss), og klikk på det.</li>
          <li>
            Ser du det ikke: klikk <strong>…</strong> øverst til høyre → <strong>Apper</strong> →{' '}
            <strong>Installer dette nettstedet som en app</strong>
          </li>
          <li>Klikk <strong>Installer</strong>. Appen åpnes i eget vindu og legges i Start-menyen.</li>
        </ol>
      )}
      {b === 'safari' && (
        <ol className="install-steps">
          <li>
            I menylinjen: <strong>Arkiv</strong> → <strong>Legg til i Dock…</strong>
          </li>
          <li>Klikk <strong>Legg til</strong>. Appen ligger da i Dock og åpnes i eget vindu.</li>
        </ol>
      )}
      {(b === 'firefox' || b === 'other') && (
        <p style={{ margin: 0 }}>
          Denne nettleseren kan ikke installere apper på PC. Åpne <strong>{location.host}</strong> i <strong>Chrome</strong> eller{' '}
          <strong>Edge</strong>, og klikk «Installer appen» der.
        </p>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Du er fortsatt logget inn i appen etterpå, og den oppdaterer seg selv.
      </p>
    </Modal>
  );
}

/**
 * "Installer appen": installs straight away when the browser has offered it, otherwise explains how.
 * Hidden when the app already runs installed. On phones it only shows when the browser can install (Android).
 */
export function InstallButton({ className = 'btn ghost side-add', always = false }: { className?: string; always?: boolean }) {
  const [, setTick] = useState(0);
  const [help, setHelp] = useState(false);
  const toast = useToast();
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  if (installed() || (!deferred && !always)) return null;
  return (
    <>
      <button
        className={className}
        onClick={async () => {
          const p = deferred;
          if (!p) return setHelp(true);
          await p.prompt();
          const { outcome } = await p.userChoice;
          deferred = null;
          notify();
          if (outcome === 'accepted') toast('Budsjett er installert. Du finner den i Start-menyen og på skrivebordet.');
        }}
      >
        <Icon name="upload" size={16} /> Installer appen
      </button>
      {help && <HowToInstall onClose={() => setHelp(false)} />}
    </>
  );
}
