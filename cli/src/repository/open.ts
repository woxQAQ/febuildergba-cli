/**
 * Repository connection. drizzle has no `node:sqlite` driver, so this
 * adapts `DatabaseSync` to drizzle's sqlite-proxy interface: drizzle builds
 * typed SQL from `schema.ts`, the callback runs it on the built-in driver. The
 * proxy callback is async in type only.
 *
 * Two details: the callback caches prepared statements by SQL text (drizzle
 * rebuilds the same string per row, ~30k per extract); and it returns rows as
 * value arrays in column order, which `Object.values` gives for `node:sqlite`'s
 * null-prototype objects.
 */

import { DatabaseSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import * as schema from "./schema.ts";

export type ExtractSchema = typeof schema;
export type ExtractDb = SqliteRemoteDatabase<ExtractSchema>;

export interface OpenDb {
  /** Typed drizzle handle. */
  db: ExtractDb;
  /**
   * The raw driver, for DDL (`exec`), transactions and the rare query that
   * does not go through drizzle.
   */
  sqlite: DatabaseSync;
  close(): void;
}

export function openDb(path: string, options: { readOnly?: boolean } = {}): OpenDb {
  const sqlite = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
  const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  const db = drizzle(
    async (sql, params, method) => {
      let stmt = statements.get(sql);
      if (stmt === undefined) {
        stmt = sqlite.prepare(sql);
        statements.set(sql, stmt);
      }
      if (method === "run") {
        stmt.run(...(params as never[]));
        return { rows: [] };
      }
      const rows = (stmt.all(...(params as never[])) as Record<string, unknown>[]).map((row) =>
        Object.values(row),
      );
      // 'get' wants a single row; 'all'/'values' want them all.
      return method === "get" ? { rows: (rows[0] ?? []) as unknown[] } : { rows };
    },
    undefined,
    { schema },
  );

  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}
