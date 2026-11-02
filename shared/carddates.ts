/**
 * Credit card dates, shared by the server and the app: which bill a day's purchases land on, when that bill
 * closes (fakturadato), and when it must be paid (forfall).
 */
import { addDays, addMonths, daysInMonth } from './months.ts';

export interface CardDates {
  statement_day: number | null;
  due_day: number | null;
  free_days: number | null;
}

const clampDay = (month: string, day: number) => `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`;

/** The day a billing period closes in a given month. Month end when the statement day isn't set. */
export function closeIn(month: string, statementDay: number | null) {
  return clampDay(month, statementDay ?? 31);
}

/** The most recent close before `date`, and the next one on or after it (a period is open through its close day). */
export function closesAround(date: string, statementDay: number | null) {
  const month = date.slice(0, 7);
  const thisClose = closeIn(month, statementDay);
  const last = date > thisClose ? thisClose : closeIn(addMonths(month, -1), statementDay);
  const next = date > thisClose ? closeIn(addMonths(month, 1), statementDay) : thisClose;
  return { last, next, before: (close: string) => closeIn(addMonths(close.slice(0, 7), -1), statementDay) };
}

/** When the bill for the period closing on `close` is due. */
export function dueFor(close: string, prevClose: string, t: CardDates): { due: string; estimate: boolean } {
  if (t.due_day) {
    const sameMonth = clampDay(close.slice(0, 7), t.due_day);
    return { due: sameMonth > close ? sameMonth : clampDay(addMonths(close.slice(0, 7), 1), t.due_day), estimate: false };
  }
  // "Up to N interest-free days" counts from the first day of the period.
  if (t.free_days) return { due: addDays(prevClose, t.free_days), estimate: false };
  return { due: addDays(close, 20), estimate: true };
}

