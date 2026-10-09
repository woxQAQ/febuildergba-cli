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

/**
 * Support pairs, deduplicated from the asymmetric `support_partners`.
 * Mirrors `buildSupportGraph` (tables/supports.ts): the pair is normalized
 * a < b, the numbers come from the a-side record when it exists, and the
 * reverse side is exposed so a mismatch is a WHERE clause, not a parse.
 */
export const SUPPORT_EDGES_VIEW_SQL = `
CREATE VIEW support_edges AS
SELECT
  pairs.a,
  pairs.b,
  COALESCE(f.initial, r.initial) AS initial,
  COALESCE(f.growth,  r.growth)  AS growth,
  (r.unit_id IS NOT NULL)        AS reciprocal,
  r.initial AS reverse_initial,  -- NULL when the pair is one-way
  r.growth  AS reverse_growth
FROM (
  SELECT DISTINCT
    MIN(unit_id, partner_id) AS a,
    MAX(unit_id, partner_id) AS b
  FROM support_partners
) pairs
LEFT JOIN support_partners f ON f.unit_id = pairs.a AND f.partner_id = pairs.b
LEFT JOIN support_partners r ON r.unit_id = pairs.b AND r.partner_id = pairs.a`;

/** Every view, in creation order. */
export const VIEWS = [ROSTER_VIEW_SQL, SUPPORT_EDGES_VIEW_SQL];

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
  return [...tables.map(createTableSql), ...VIEWS];
}
