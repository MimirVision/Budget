/**
 * Mottakere: everyone the money goes to (or comes from), as one entry each. Giving a payee a category sets it on all
 * its transactions and remembers it for new ones (an "er nøyaktig" rule). Renaming changes the name on every
 * transaction and teaches the importer the new name; renaming to a name that's already there merges the two.
 */
import { all, get, run, tx, type DB } from './db.ts';

export interface PayeeRow {
  payee: string;
  count: number;
  spent: number;
  received: number;
  last: string;
  /** The category set for this payee (its rule), if any. */
  category_id: number | null;
  /** The category used most often, as a hint when none is set. */
  usual_category_id: number | null;
  usual_category: string | null;
  /** Names from the bank that are renamed to this one. */
  aliases: string[];
}

const NOT_REAL = "t.payee NOT IN ('', 'Startsaldo', 'Saldojustering') AND t.transfer_id IS NULL";

export function listPayees(db: DB): PayeeRow[] {
  const rows = all<{ payee: string; count: number; spent: number; received: number; last: string }>(
    db,
    `SELECT MAX(t.payee) AS payee, COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0) AS spent,
            COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS received,
            MAX(t.date) AS last
       FROM transactions t WHERE ${NOT_REAL}
      GROUP BY lower(t.payee) ORDER BY spent DESC, count DESC`,
  );
  const usual = new Map<string, { id: number; name: string }>();
  for (const u of all<{ key: string; id: number; name: string }>(
    db,
    `SELECT lower(t.payee) AS key, c.id, c.name, COUNT(*) AS n FROM transactions t JOIN categories c ON c.id = t.category_id
      WHERE ${NOT_REAL} GROUP BY lower(t.payee), c.id ORDER BY n DESC`,
  ))
    if (!usual.has(u.key)) usual.set(u.key, { id: u.id, name: u.name });
  const rules = all<{ pattern: string; category_id: number | null; rename_to: string | null }>(
    db,
    "SELECT pattern, category_id, rename_to FROM rules WHERE match_type = 'equals' AND account_id IS NULL",
  );
  const ruleFor = new Map(rules.filter((r) => !r.rename_to).map((r) => [r.pattern.toLowerCase(), r.category_id]));
  const aliases = new Map<string, string[]>();
  for (const r of rules.filter((r) => r.rename_to)) {
    const k = r.rename_to!.toLowerCase();
    aliases.set(k, [...(aliases.get(k) ?? []), r.pattern]);
    // A rename rule can carry the category too.
    if (r.category_id && !ruleFor.has(k)) ruleFor.set(k, r.category_id);
  }
  return rows.map((r) => {
    const k = r.payee.toLowerCase();
    const u = usual.get(k);
    return { ...r, category_id: ruleFor.get(k) ?? null, usual_category_id: u?.id ?? null, usual_category: u?.name ?? null, aliases: aliases.get(k) ?? [] };
  });
}

/**
 * Sets the payee's category on all its transactions (not transfers or split ones) and for new ones. Returns how
 * many changed, what they were before and the category the payee had before, so it can be undone. With
 * `onlyRule` the transactions are left as they are (used when undoing).
 */
export function setPayeeCategory(db: DB, payee: string, categoryId: number | null, onlyRule = false) {
  const name = payee.trim();
  if (!name) throw new Error('Velg en mottaker');
  let before: Array<{ id: number; category_id: number | null; reviewed: number }> = [];
  let previous: number | null = null;
  tx(db, () => {
    const rule = get<{ id: number; category_id: number | null }>(
      db,
      "SELECT id, category_id FROM rules WHERE match_type = 'equals' AND account_id IS NULL AND rename_to IS NULL AND pattern = ? COLLATE NOCASE",
      name,
    );
    previous = rule?.category_id ?? null;
    if (categoryId) {
      if (rule) run(db, 'UPDATE rules SET category_id = ? WHERE id = ?', categoryId, rule.id);
      else run(db, "INSERT INTO rules(match_type, pattern, category_id) VALUES ('equals', ?, ?)", name, categoryId);
      // Bank names that are renamed to this payee get the category too.
      run(db, "UPDATE rules SET category_id = ? WHERE match_type = 'equals' AND rename_to = ? COLLATE NOCASE", categoryId, name);
      if (onlyRule) return;
      before = all(
        db,
        `SELECT id, category_id, reviewed FROM transactions t
          WHERE lower(t.payee) = lower(?) AND t.transfer_id IS NULL AND (t.category_id IS NOT ? OR t.reviewed = 0)
            AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)`,
        name,
        categoryId,
      );
      run(
        db,
        `UPDATE transactions SET category_id = ?, reviewed = 1
          WHERE lower(payee) = lower(?) AND transfer_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = transactions.id)`,
        categoryId,
        name,
      );
    } else if (rule) {
      // No fixed category any more: forget the rule; the transactions keep what they have.
      run(db, 'DELETE FROM rules WHERE id = ?', rule.id);
    }
  });
  return { changed: before.length, before, previous };
}

/** Renames a payee everywhere and for new imports. Renaming to an existing payee merges them. */
export function renamePayee(db: DB, from: string, to: string) {
  const oldName = from.trim();
  const newName = to.trim().slice(0, 80);
  if (!oldName || !newName) throw new Error('Skriv inn det nye navnet');
  if (oldName.toLowerCase() === newName.toLowerCase() && oldName === newName) return { changed: 0 };
  let changed = 0;
  tx(db, () => {
    changed = Number(run(db, 'UPDATE transactions SET payee = ? WHERE lower(payee) = lower(?)', newName, oldName).changes ?? 0);
    const catOf = (p: string) =>
      get<{ category_id: number | null }>(
        db,
        "SELECT category_id FROM rules WHERE match_type = 'equals' AND account_id IS NULL AND rename_to IS NULL AND pattern = ? COLLATE NOCASE",
        p,
      )?.category_id ?? null;
    const category = catOf(newName) ?? catOf(oldName);
    // The old name's own rule becomes a rename rule (keeping its category); names already renamed to the old name follow.
    run(db, "DELETE FROM rules WHERE match_type = 'equals' AND account_id IS NULL AND rename_to IS NULL AND pattern = ? COLLATE NOCASE", oldName);
    if (oldName.toLowerCase() !== newName.toLowerCase())
      run(db, "INSERT INTO rules(match_type, pattern, category_id, rename_to) VALUES ('equals', ?, ?, ?)", oldName, category, newName);
    run(db, "UPDATE rules SET rename_to = ? WHERE match_type = 'equals' AND rename_to = ? COLLATE NOCASE", newName, oldName);
    if (category) {
      const own = get(db, "SELECT 1 FROM rules WHERE match_type = 'equals' AND account_id IS NULL AND rename_to IS NULL AND pattern = ? COLLATE NOCASE", newName);
      if (!own) run(db, "INSERT INTO rules(match_type, pattern, category_id) VALUES ('equals', ?, ?)", newName, category);
    }
  });
  return { changed };
}
