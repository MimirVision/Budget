import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'checking',      -- checking | savings | credit | cash | loan
  institution TEXT,
  on_budget INTEGER NOT NULL DEFAULT 1,
  closed INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  bank_balance INTEGER,                        -- last balance reported by the bank (øre)
  bank_balance_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS category_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  is_income INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES category_groups(id),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  target_type TEXT,                            -- monthly | by_date | balance
  target_amount INTEGER,
  target_date TEXT,                            -- YYYY-MM for by_date
  note TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                          -- YYYY-MM-DD
  amount INTEGER NOT NULL,                     -- øre, negative = money out
  payee TEXT NOT NULL DEFAULT '',
  raw_description TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  transfer_id INTEGER,                         -- the matching transaction in the other account
  suggested_category_id INTEGER,
  suggestion_source TEXT,                      -- rule | history | merchant
  suggested_transfer_id INTEGER,
  reviewed INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',       -- manual | csv | enablebanking | sparebank1 | transfer
  external_id TEXT,
  import_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tx_external ON transactions(account_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tx_hash ON transactions(account_id, import_hash) WHERE import_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS tx_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS tx_review ON transactions(reviewed);

CREATE TABLE IF NOT EXISTS splits (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS split_tx ON splits(transaction_id);

CREATE TABLE IF NOT EXISTS assignments (
  month TEXT NOT NULL,                         -- YYYY-MM
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, category_id)
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  match_type TEXT NOT NULL DEFAULT 'contains', -- contains | equals | starts
  pattern TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  rename_to TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | active | expired | error
  data TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connection_accounts (
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  remote_name TEXT NOT NULL DEFAULT '',
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  PRIMARY KEY (connection_id, remote_id)
);

CREATE TABLE IF NOT EXISTS pending_auth (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  seedDefaults(db);
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function all<T = any>(db: DB, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = any>(db: DB, sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: DB, sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export function getSetting(db: DB, key: string): string | undefined {
  return get<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? undefined;
}

export function setSetting(db: DB, key: string, value: string | null) {
  if (value === null || value === '') run(db, 'DELETE FROM settings WHERE key = ?', key);
  else run(db, 'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

/** A sensible Norwegian household starting point. Everything can be renamed, hidden or deleted. */
export const DEFAULT_CATEGORIES: Array<{ group: string; income?: boolean; items: string[] }> = [
  { group: 'Inntekt', income: true, items: ['Lønn', 'Annen inntekt'] },
  {
    group: 'Faste utgifter',
    items: ['Boliglån', 'Strøm', 'Forsikring', 'Internett og mobil', 'Kommunale avgifter', 'Abonnementer', 'Barnehage og SFO'],
  },
  { group: 'Hverdag', items: ['Dagligvarer', 'Spise ute', 'Transport og drivstoff', 'Hus og apotek', 'Klær', 'Barn'] },
  { group: 'Sparemål', items: ['Buffer', 'Ferie', 'Jul og gaver', 'Bilvedlikehold', 'Vedlikehold bolig'] },
  { group: 'Kos', items: ['Lommepenger', 'Hobby og sport', 'Helse og velvære'] },
];

function seedDefaults(db: DB) {
  const count = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM category_groups')!.n;
  if (count > 0) return;
  tx(db, () => {
    DEFAULT_CATEGORIES.forEach((g, gi) => {
      const groupId = run(db, 'INSERT INTO category_groups(name, sort, is_income) VALUES (?, ?, ?)', g.group, gi, g.income ? 1 : 0)
        .lastInsertRowid;
      g.items.forEach((name, ci) => run(db, 'INSERT INTO categories(group_id, name, sort) VALUES (?, ?, ?)', groupId, name, ci));
    });
  });
}
