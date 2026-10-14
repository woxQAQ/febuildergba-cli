/**
 * DDL generation from the drizzle schema (`schema.ts` is the source of truth;
 * no second, hand-written SQL copy). Covers only what the extract schema uses -
 * integer/text/real columns, NOT NULL, inline/composite primary keys,
 * single-column and composite foreign keys; anything else fails here, loudly,
 * at extract time.
 *
 * The emitted FOREIGN KEY clauses are enforced, not merely declared: the write
 * connection runs with `PRAGMA foreign_keys = ON`, set and asserted in
 * `write.ts`. The invariant itself is stated in `schema.ts`.
 *
 * Tables only, because tables are all the extract creates: the derivations that
 * used to ship as db views (roster, class_roles, support_edges,
 * chapter_transitions, chapter_recruits(+_units), chapter_gold,
 * chapter_item_gives, unit_joins) are CLI commands over the parsed ROM now -
 * see `src/commands/`.
 */

import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

export function createTableSql(table: SQLiteTable): string {
  const config = getTableConfig(table);

  const columns = config.columns.map((c) => {
    const sqlType = c.getSQLType().toUpperCase();
    if (!["INTEGER", "TEXT", "REAL"].includes(sqlType)) {
      throw new Error(`${config.name}.${c.name}: unsupported column type "${sqlType}"`);
    }
    return `${c.name} ${sqlType}${c.notNull ? " NOT NULL" : ""}`;
  });

  // Primary keys arrive in one of two shapes: inline (`primaryKey()` on the
  // column) sets `column.primary`; the table-level builder fills
  // `config.primaryKeys`. Both become one table-level constraint here.
  const inlinePk = config.columns.filter((c) => c.primary);
  if (inlinePk.length > 0) {
    columns.push(`PRIMARY KEY (${inlinePk.map((c) => c.name).join(", ")})`);
  }
  for (const pk of config.primaryKeys) {
    columns.push(`PRIMARY KEY (${pk.columns.map((c) => c.name).join(", ")})`);
  }

  for (const fk of config.foreignKeys) {
    const ref = fk.reference();
    const foreignName = getTableConfig(ref.foreignTable).name;
    const from = ref.columns.map((c) => c.name).join(", ");
    const to = ref.foreignColumns.map((c) => c.name).join(", ");
    columns.push(`FOREIGN KEY (${from}) REFERENCES ${foreignName} (${to})`);
  }

  return `CREATE TABLE ${config.name} (\n  ${columns.join(",\n  ")}\n)`;
}

/** CREATE TABLE for every data table, in dependency order. */
export function createTablesSql(tables: readonly SQLiteTable[]): string[] {
  return tables.map(createTableSql);
}
