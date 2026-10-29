/**
 * Bank CSV parsing with automatic format detection. Handles the quirks of Norwegian bank exports
 * (semicolons, "1 234,56" amounts, dd.mm.yyyy dates, separate in/out columns) and Revolut's export.
 */

export interface CsvMapping {
  delimiter: string;
  headerRow: number; // index of the header row, -1 when the file has no header
  date: number;
  description: number;
  amount?: number; // single signed amount column
  inflow?: number; // or separate in/out columns
  outflow?: number;
  fee?: number;
  state?: number; // Revolut: only COMPLETED rows are real
  dateFormat: 'dmy' | 'ymd' | 'mdy';
  invert: boolean; // credit card exports often show purchases as positive numbers
}

export interface ParsedRow {
  date: string;
  amount: number; // øre
  description: string;
}

export interface CsvPreview {
  format: string; // human readable: "Revolut", "SpareBank 1", "DNB", "Generic"
  headers: string[];
  sample: string[][];
  mapping: CsvMapping;
  rows: ParsedRow[];
  skipped: number;
  warnings: string[];
}

export function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
  return rows;
}

export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const d of [';', ',', '\t', '|']) {
    const counts = lines.map((l) => splitCsv(l, d)[0]?.length ?? 0);
    const min = Math.min(...counts);
    // Prefer a delimiter that gives several columns consistently.
    const score = min > 1 ? min * 10 - (Math.max(...counts) - min) : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Parses "1 234,56", "-1234.56", "1.234,56", "kr 99,-" into øre. */
export function parseAmount(input: string): number | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/kr\.?|nok|eur|usd|sek|dkk/gi, '').replace(/[\s  ']/g, '');
  s = s.replace(/,-$/, '');
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = (s.match(/,/g)!.length > 1 ? s.replace(/,/g, '') : s.replace(',', '.'));
  } else if ((s.match(/\./g) ?? []).length > 1) {
    normalized = s.replace(/\./g, '');
  } else normalized = s;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  const ore = Math.round(n * 100);
  return negative ? -ore : ore;
}

export function parseDate(input: string, format: CsvMapping['dateFormat']): string | null {
  const s = (input ?? '').trim();
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000;
    return format === 'mdy' ? iso(year, +m[1], +m[2]) : iso(year, +m[2], +m[1]);
  }
  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const HEADER_HINTS = {
  date: /^(dato|date|bokført|bokføringsdato|bokført dato|transaksjonsdato|utført dato|kjøpsdato|completed date|booking date|transaction date|started date|rentedato)$/i,
  description: /(beskrivelse|forklaring|tekst|description|transaksjonstekst|mottaker|merchant|spesifikasjon|detaljer|payee)/i,
  amount: /^(beløp|beløp i nok|beløp nok|amount|sum|beløp \(nok\)|nok)$/i,
  inflow: /^(inn|inn på konto|innskudd|credit|kredit|inngående|innbetaling|money in|paid in)$/i,
  outflow: /^(ut|ut fra konto|uttak|debit|debet|utgående|utbetaling|money out|paid out)$/i,
  fee: /^(fee|gebyr)$/i,
  state: /^(state|status)$/i,
};

function findCol(headers: string[], re: RegExp, exclude: number[] = []): number | undefined {
  const i = headers.findIndex((h, idx) => !exclude.includes(idx) && re.test(h.trim()));
  return i >= 0 ? i : undefined;
}

export function detectMapping(rows: string[][], delimiter: string): { mapping: CsvMapping; format: string } {
  // The header is the first row that is mostly text and contains a date-ish column name.
  let headerRow = rows.findIndex((r, i) => i < 10 && r.some((c) => HEADER_HINTS.date.test(c.trim())));
  const headers = headerRow >= 0 ? rows[headerRow] : [];
  const lower = headers.map((h) => h.toLowerCase());
  let format = 'Generic';

  let mapping: CsvMapping = {
    delimiter,
    headerRow,
    date: 0,
    description: 1,
    dateFormat: 'dmy',
    invert: false,
  };

  if (lower.includes('started date') && lower.includes('product') && lower.includes('amount')) {
    format = 'Revolut';
    mapping = {
      ...mapping,
      date: lower.indexOf('started date'),
      description: lower.indexOf('description'),
      amount: lower.indexOf('amount'),
      fee: lower.indexOf('fee') >= 0 ? lower.indexOf('fee') : undefined,
      state: lower.indexOf('state') >= 0 ? lower.indexOf('state') : undefined,
    };
  } else if (headerRow >= 0) {
    const date = findCol(headers, HEADER_HINTS.date) ?? 0;
    const description = findCol(headers, HEADER_HINTS.description, [date]) ?? (date === 0 ? 1 : 0);
    const inflow = findCol(headers, HEADER_HINTS.inflow);
    const outflow = findCol(headers, HEADER_HINTS.outflow);
    const amount = findCol(headers, HEADER_HINTS.amount);
    mapping = { ...mapping, date, description };
    if (inflow !== undefined && outflow !== undefined) Object.assign(mapping, { inflow, outflow });
    else if (amount !== undefined) mapping.amount = amount;
    if (lower.some((h) => h.includes('ut fra konto'))) format = 'DNB';
    else if (lower.includes('inn') && lower.includes('ut') && lower.includes('beskrivelse')) format = 'SpareBank 1';
  } else {
    // No header: guess columns from content.
    headerRow = -1;
    const sample = rows.slice(0, 20);
    const width = Math.max(...sample.map((r) => r.length));
    const dateCol = range(width).find((c) => sample.filter((r) => parseDate(r[c], 'dmy')).length > sample.length / 2) ?? 0;
    const amountCol =
      range(width).find((c) => c !== dateCol && sample.filter((r) => /\d/.test(r[c] ?? '') && parseAmount(r[c]) !== null).length > sample.length / 2) ?? 1;
    const descCol =
      range(width).find((c) => c !== dateCol && c !== amountCol && sample.some((r) => /[a-zæøå]{3,}/i.test(r[c] ?? ''))) ?? 2;
    mapping = { ...mapping, headerRow, date: dateCol, amount: amountCol, description: descCol };
  }

  // Date format: if any value has a first part > 12 it can't be month-first.
  const dataRows = rows.slice(headerRow + 1, headerRow + 60);
  const dateVals = dataRows.map((r) => r[mapping.date] ?? '');
  if (dateVals.some((d) => /^\d{4}/.test(d))) mapping.dateFormat = 'ymd';

  return { mapping, format };
}

function range(n: number) {
  return Array.from({ length: n }, (_, i) => i);
}

export function applyMapping(rows: string[][], mapping: CsvMapping): { rows: ParsedRow[]; skipped: number } {
  const out: ParsedRow[] = [];
  let skipped = 0;
  for (const r of rows.slice(mapping.headerRow + 1)) {
    if (mapping.state !== undefined) {
      const state = (r[mapping.state] ?? '').toUpperCase();
      if (state && state !== 'COMPLETED') {
        skipped++;
        continue;
      }
    }
    const date = parseDate(r[mapping.date], mapping.dateFormat);
    let amount: number | null = null;
    if (mapping.amount !== undefined) amount = parseAmount(r[mapping.amount]);
    else if (mapping.inflow !== undefined || mapping.outflow !== undefined) {
      const inflow = mapping.inflow !== undefined ? parseAmount(r[mapping.inflow]) : null;
      const outflow = mapping.outflow !== undefined ? parseAmount(r[mapping.outflow]) : null;
      if (inflow !== null || outflow !== null) amount = Math.abs(inflow ?? 0) - Math.abs(outflow ?? 0);
    }
    if (amount !== null && mapping.fee !== undefined) amount -= Math.abs(parseAmount(r[mapping.fee]) ?? 0);
    if (!date || amount === null) {
      skipped++;
      continue;
    }
    if (mapping.invert) amount = -amount;
    out.push({ date, amount, description: (r[mapping.description] ?? '').trim() });
  }
  return { rows: out, skipped };
}

export function previewCsv(text: string, accountKind: string, override?: Partial<CsvMapping>): CsvPreview {
  const clean = text.replace(/^﻿/, '');
  const delimiter = override?.delimiter ?? detectDelimiter(clean);
  const rows = splitCsv(clean, delimiter);
  const detected = detectMapping(rows, delimiter);
  let mapping = { ...detected.mapping, ...override, delimiter };
  const warnings: string[] = [];

  let parsed = applyMapping(rows, mapping);
  if (!override || override.invert === undefined) {
    // Card statements that list purchases as positive numbers: spending should be negative.
    const positives = parsed.rows.filter((r) => r.amount > 0).length;
    if (accountKind === 'credit' && parsed.rows.length >= 3 && positives / parsed.rows.length > 0.7) {
      mapping = { ...mapping, invert: true };
      parsed = applyMapping(rows, mapping);
      warnings.push('Purchases looked like positive numbers, so signs were flipped. Untick "Flip signs" if that is wrong.');
    }
  }
  if (parsed.rows.length === 0) warnings.push('No transactions could be read. Check the column choices below.');

  return {
    format: detected.format,
    headers: mapping.headerRow >= 0 ? rows[mapping.headerRow] : (rows[0] ?? []).map((_, i) => `Column ${i + 1}`),
    sample: rows.slice(mapping.headerRow + 1, mapping.headerRow + 6),
    mapping,
    rows: parsed.rows,
    skipped: parsed.skipped,
    warnings,
  };
}
