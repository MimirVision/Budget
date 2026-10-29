const nok = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** 123456 øre → "1 234,56 kr" (drops ",00"). */
export function kr(ore: number, opts: { sign?: boolean } = {}): string {
  const value = ore / 100;
  const text = nok.format(Math.abs(value));
  const sign = value < 0 ? '−' : opts.sign && value > 0 ? '+' : '';
  return `${sign}${text} kr`;
}

/** Accepts "1 234,50", "1234.5", "-200", and simple maths like "1500+250" or "3*120". Returns øre. */
export function parseMoney(input: string): number | null {
  const s = input.replace(/kr/gi, '').replace(/[\s ]/g, '').replace(/−/g, '-').replace(/,/g, '.');
  if (!s) return 0;
  if (!/^[-+*/().\d]+$/.test(s)) return null;
  try {
    // Only digits and operators are allowed through, so this can't run anything else.
    const n = Function(`"use strict"; return (${s});`)();
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  } catch {
    return null;
  }
}

export function toInput(ore: number): string {
  if (!ore) return '';
  return (ore / 100).toFixed(2).replace(/\.00$/, '').replace('.', ',');
}

const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const shortMonthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short' });
const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export const monthLabel = (m: string) => monthFmt.format(new Date(`${m}-15T12:00:00`));
export const shortMonth = (m: string) => shortMonthFmt.format(new Date(`${m}-15T12:00:00`));
export const dayLabel = (d: string) => dayFmt.format(new Date(`${d}T12:00:00`));

export function relativeDay(d: string): string {
  const today = new Date();
  const date = new Date(`${d}T12:00:00`);
  const diff = Math.round((date.getTime() - new Date(today.toDateString()).getTime() - 12 * 3600_000) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return `In ${diff} days`;
  return dayLabel(d);
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
