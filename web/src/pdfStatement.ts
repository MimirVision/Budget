/**
 * Kontoutskrift som PDF (TF Bank and other banks without CSV export): read the text out of the PDF in the
 * browser, find the transaction lines, and turn them into the same CSV the importer already understands.
 * Nothing is uploaded except the transactions it finds.
 */

export interface StatementRow {
  date: string; // YYYY-MM-DD
  description: string;
  amount: string; // as written in the statement, e.g. "-1 234,56"
}

/** Text lines of a PDF, top to bottom, with the pieces on each line in reading order. */
export async function pdfLines(file: File): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group the text pieces by their height on the page (a couple of points of slack), then left to right.
    const rows = new Map<number, Array<{ x: number; s: string }>>();
    for (const item of content.items as Array<{ str: string; transform: number[] }>) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      const x = item.transform[4];
      rows.set(y, [...(rows.get(y) ?? []), { x, s: item.str }]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      lines.push(
        rows
          .get(y)!
          .sort((a, b) => a.x - b.x)
          .map((r) => r.s.trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
  }
  return lines;
}

const DATE = /(?<!\d)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?!\d)/;
// Norwegian amounts: "1 234,56", "1.234,56", "-1234,56", "1 234,56-" (minus after, as some banks print), "kr 99,00".
const AMOUNT = /(?<![\d,])-?\s?\d{1,3}(?:[ .  ]\d{3})*,\d{2}(?:\s?-)?(?![\d])/g;
const SKIP = /\b(saldo|sum|totalt|total|overført fra|forrige faktura|minste ?beløp|å betale|forfallsdato|kredittgrense|disponibelt|rente(?:r)? hittil|side \d)\b/i;

/** Finds the year the statement is about, for lines that only say "12.10". */
function statementYear(lines: string[], today = new Date()): number {
  for (const l of lines) {
    const m = l.match(/(?<!\d)\d{1,2}[./-]\d{1,2}[./-](20\d{2})(?!\d)/);
    if (m) return Number(m[1]);
  }
  return today.getFullYear();
}

function normalizeAmount(s: string): string {
  const t = s.replace(/[\s  ]/g, '');
  const trailingMinus = t.endsWith('-');
  const core = t.replace(/-$/, '');
  return trailingMinus && !core.startsWith('-') ? `-${core}` : core;
}

/** Pulls transactions out of statement lines: a date at the start, an amount at the end, the text in between. */
export function parseStatement(lines: string[], today = new Date()): StatementRow[] {
  const year = statementYear(lines, today);
  const hasBalanceColumn = lines.some((l) => /\bsaldo\b/i.test(l) && /\bbeløp\b/i.test(l));
  const rows: StatementRow[] = [];
  for (const line of lines) {
    const d = line.match(DATE);
    if (!d || d.index! > 3) continue; // a transaction line starts with its date
    if (SKIP.test(line)) continue;
    const amounts = [...line.matchAll(AMOUNT)];
    if (!amounts.length) continue;
    // With a balance column the transaction amount is the one before it; otherwise it's the last one
    // (a foreign amount, if any, comes first).
    const pick = hasBalanceColumn && amounts.length >= 2 ? amounts[amounts.length - 2] : amounts[amounts.length - 1];
    const [day, month, y] = [Number(d[1]), Number(d[2]), d[3]];
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    let fullYear = y ? Number(y.length === 2 ? `20${y}` : y) : year;
    // A statement over New Year: December lines without a year belong to the year before.
    if (!y && month === 12 && today.getMonth() < 2 && year === today.getFullYear()) fullYear = year - 1;
    let description = line.slice(d.index! + d[0].length, amounts[0].index!).trim();
    // Many statements have two dates (purchase and booking); drop the second one from the text.
    description = description.replace(new RegExp(`^${DATE.source}\\s*`), '').trim();
    if (!description) continue;
    rows.push({
      date: `${fullYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      description,
      amount: normalizeAmount(pick[0]),
    });
  }
  return rows;
}

/** The rows as CSV for the existing importer: Dato;Beskrivelse;Beløp with Norwegian dates and amounts. */
export function statementCsv(rows: StatementRow[]): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [
    'Dato;Beskrivelse;Beløp',
    ...rows.map((r) => `${r.date.slice(8, 10)}.${r.date.slice(5, 7)}.${r.date.slice(0, 4)};${esc(r.description)};${r.amount}`),
  ].join('\n');
}
