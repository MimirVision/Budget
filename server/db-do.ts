import type { DB, Statement } from './db.ts';

// Durable Object SQLite only accepts strings, numbers, null and binary as parameters.
const clean = (params: any[]) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

/** Wraps a Durable Object's SQLite storage in the same small API node:sqlite offers. */
export function durableObjectDb(storage: DurableObjectStorage): DB {
  const sql = storage.sql;
  return {
    prepare(query: string): Statement {
      return {
        all: (...params) => sql.exec(query, ...clean(params)).toArray(),
        get: (...params) => sql.exec(query, ...clean(params)).toArray()[0],
        run: (...params) => {
          const cursor = sql.exec(query, ...clean(params));
          cursor.toArray();
          const id = sql.exec('SELECT last_insert_rowid() AS id').one().id as number;
          return { lastInsertRowid: id, changes: cursor.rowsWritten };
        },
      };
    },
    exec(query: string) {
      sql.exec(query);
    },
    transaction: (fn) => storage.transactionSync(fn),
  };
}
