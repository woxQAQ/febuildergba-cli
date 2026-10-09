/**
 * DDL generation from the drizzle schema.
 *
 * The drizzle table definitions in `schema.ts` are the source of truth; this
 * derives the CREATE TABLE statements from them, so there is no second,
 * hand-written SQL copy to drift away from. It deliberately covers only the
 * subset the extract schema uses: integer/text/real columns, NOT NULL,
 * primary keys (inline or composite) and single-column foreign keys. A
 * schema feature outside that subset fails here, loudly, at extract time.
 *
 * The `roster` view stays as raw SQL - drizzle's view API would not make one
 * SELECT more readable.
 */

import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

/** The roster: units carrying support data, the old `units` command's default filter. */
export const ROSTER_VIEW_SQL =
  "CREATE VIEW roster AS SELECT * FROM units WHERE has_support_data = 1";

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

/** CREATE TABLE for every data table, plus the views, in dependency order. */
export function createSchemaSql(tables: readonly SQLiteTable[]): string[] {
  return [...tables.map(createTableSql), ROSTER_VIEW_SQL];
}
