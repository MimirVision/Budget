/** "Versjon a214bb7 · 30. okt. 18:02": lets you see at a glance that an update has reached this device. */
export function AppVersion() {
  const built = new Date(__APP_BUILT__);
  const when = Number.isNaN(built.getTime())
    ? ''
    : ` · ${built.toLocaleString('nb-NO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' })}`;
  return (
    <div className="app-version small faint">
      Versjon {__APP_VERSION__}
      {when}
    </div>
  );
}
