/**
 * Small visual pieces shared by the pages: progress rings (as in Fitness and Apple Card), coloured icon tiles
 * (as in Settings), and the colour and symbol each kind of spending gets, so a category, its transactions and
 * its bills look the same everywhere.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './ui';

export interface Tint {
  color: string;
  icon: string;
}

/** Colour and symbol for a category group, from its name (the default groups and common Norwegian names). */
export function groupTint(name: string | null | undefined): Tint {
  const n = (name ?? '').toLowerCase();
  if (/kredittkort|kort/.test(n)) return { color: 'var(--t-indigo)', icon: 'card' };
  if (/fast|regning|bolig|hus/.test(n)) return { color: 'var(--t-blue)', icon: 'home' };
  if (/hverdag|mat|daglig/.test(n)) return { color: 'var(--t-orange)', icon: 'cart' };
  if (/spar|mål|buffer|ferie/.test(n)) return { color: 'var(--t-green)', icon: 'leaf' };
  if (/kos|fritid|moro|gave/.test(n)) return { color: 'var(--t-pink)', icon: 'heart' };
  if (/inntekt|lønn/.test(n)) return { color: 'var(--t-teal)', icon: 'trend' };
  return { color: 'var(--t-gray)', icon: 'list' };
}

/** A stable colour for anything without a group (a payee, an account), picked from its name. */
export function nameTint(name: string): string {
  const palette = ['--t-blue', '--t-orange', '--t-green', '--t-pink', '--t-indigo', '--t-teal', '--t-purple', '--t-yellow'];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(${palette[h % palette.length]})`;
}

/** A rounded square with a white symbol or letter on a colour, like the icons in Settings. */
export function Tile({ color, icon, letter, size = 28 }: { color: string; icon?: string; letter?: string; size?: number }) {
  return (
    <span className="tile" style={{ '--tile': color, width: size, height: size } as CSSProperties} aria-hidden="true">
      {icon ? <Icon name={icon} size={Math.round(size * 0.58)} /> : <span>{(letter ?? '?').trim().charAt(0).toUpperCase()}</span>}
    </span>
  );
}

/**
 * Concentric progress rings. Each ring is a share from 0 to 1 (more than 1 wraps once more, the way an
 * overspent ring shows it went past the goal).
 */
export function Rings({
  rings,
  size = 120,
  stroke = 12,
  gap = 3,
  children,
  label,
}: {
  rings: Array<{ value: number; color: string; track?: string }>;
  size?: number;
  stroke?: number;
  gap?: number;
  children?: ReactNode;
  label: string;
}) {
  const c = size / 2;
  return (
    <div className="rings" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {rings.map((r, i) => {
          const radius = c - stroke / 2 - i * (stroke + gap);
          const len = 2 * Math.PI * radius;
          const v = Math.max(0, r.value);
          const shown = Math.min(1, v);
          return (
            <g key={i} transform={`rotate(-90 ${c} ${c})`}>
              <circle cx={c} cy={c} r={radius} fill="none" stroke={r.track ?? `color-mix(in srgb, ${r.color} 16%, transparent)`} strokeWidth={stroke} />
              {v > 0 && (
                <circle
                  className="ring-arc"
                  cx={c}
                  cy={c}
                  r={radius}
                  fill="none"
                  stroke={r.color}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${Math.max(0.001, shown * len)} ${len}`}
                />
              )}
              {v > 1 && (
                <circle
                  cx={c}
                  cy={c}
                  r={radius}
                  fill="none"
                  stroke={r.color}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${Math.min(1, v - 1) * len} ${len}`}
                  style={{ filter: 'brightness(0.82)' }}
                />
              )}
            </g>
          );
        })}
      </svg>
      {children && <div className="rings-center">{children}</div>}
    </div>
  );
}
