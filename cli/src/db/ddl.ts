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

/** The roster: units carrying support data. */
export const ROSTER_VIEW_SQL =
  "CREATE VIEW roster AS SELECT * FROM units WHERE has_support_data = 1";

/**
 * Support pairs, deduplicated from the asymmetric `support_partners`.
 * The pair is normalized a < b, the numbers come from the a-side record when
 * it exists, and the reverse side is exposed so a mismatch is a WHERE clause,
 * not a parse.
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

/**
 * Every script a chapter can reach: its condition slots' scripts, plus
 * everything those CALL, recursively. Shared helpers appear once in
 * `event_scripts` but are attributed to every chapter that reaches them -
 * which is exactly their in-game behaviour.
 */
const REACHABLE_SCRIPTS = `
  WITH RECURSIVE reach(map_index, script_id) AS (
    SELECT map_index, script_id FROM chapter_event_slots WHERE script_id IS NOT NULL
    UNION
    SELECT reach.map_index, i.call_script_id
    FROM reach JOIN event_instructions i ON i.script_id = reach.script_id
    WHERE i.call_script_id IS NOT NULL
  )`;

/** Same, restricted to END_EVENT and tracking CALL depth (cap 8: deep chains are boilerplate). */
const REACHABLE_FROM_END_EVENT = `
  WITH RECURSIVE reach(map_index, script_id, depth) AS (
    SELECT map_index, script_id, 0 FROM chapter_event_slots
    WHERE slot_kind = 'END_EVENT' AND script_id IS NOT NULL
    UNION
    SELECT reach.map_index, i.call_script_id, reach.depth + 1
    FROM reach JOIN event_instructions i ON i.script_id = reach.script_id
    WHERE i.call_script_id IS NOT NULL AND reach.depth < 8
  )`;

/**
 * Story-advancing destinations, from END_EVENT scripts and their CALL
 * closure. `call_depth` > 0 means the instruction lives in a shared helper
 * and fires for every chapter that calls it.
 */
export const CHAPTER_TRANSITIONS_VIEW_SQL = `
CREATE VIEW chapter_transitions AS
${REACHABLE_FROM_END_EVENT}
SELECT r.map_index, i.opcode, i.target_map, MIN(r.depth) AS call_depth
FROM reach r JOIN event_instructions i ON i.script_id = r.script_id
WHERE i.target_map IS NOT NULL
GROUP BY r.map_index, i.script_id, i.seq, i.opcode, i.target_map`;

/**
 * Load sites: every reachable instruction that points at a unit block.
 * The instruction is identified by (script_id, seq) - no surrogate needed.
 */
export const CHAPTER_RECRUITS_VIEW_SQL = `
CREATE VIEW chapter_recruits AS
${REACHABLE_SCRIPTS}
SELECT r.map_index, i.script_id, i.seq, i.load_kind AS kind, i.block_id
FROM reach r JOIN event_instructions i ON i.script_id = r.script_id
WHERE i.block_id IS NOT NULL AND i.load_kind != 'other'`;

/** The units each load site brings in, with their allegiance. */
export const CHAPTER_RECRUIT_UNITS_VIEW_SQL = `
CREATE VIEW chapter_recruit_units AS
SELECT r.map_index, r.script_id, r.seq, r.kind,
       u.position, u.unit_id, u.class_id, u.level, u.side, u.x, u.y
FROM chapter_recruits r JOIN load_block_units u ON u.block_id = r.block_id`;

/** Direct gold writes reachable from a chapter's scripts. */
export const CHAPTER_GOLD_VIEW_SQL = `
CREATE VIEW chapter_gold AS
${REACHABLE_SCRIPTS}
SELECT DISTINCT r.map_index, i.script_id, i.seq, i.gold_delta AS delta
FROM reach r JOIN event_instructions i ON i.script_id = r.script_id
WHERE i.gold_delta IS NOT NULL`;

/** Item grants reachable from a chapter's scripts. */
export const CHAPTER_ITEM_GIVES_VIEW_SQL = `
CREATE VIEW chapter_item_gives AS
${REACHABLE_SCRIPTS}
SELECT DISTINCT r.map_index, i.script_id, i.seq, i.item_id, i.give_unit_id AS unit_id
FROM reach r JOIN event_instructions i ON i.script_id = r.script_id
WHERE i.item_id IS NOT NULL`;

/**
 * Earliest chapter per unit, from initial placements and load sites.
 * kind: "join" = in the player's army (player-side records only, placement
 * class-overrides excluded); "appearance" = any load at all. "Earliest" is
 * play position, with off-path maps last and the table row as tie-break.
 */
export const UNIT_JOINS_VIEW_SQL = `
CREATE VIEW unit_joins AS
WITH ev AS (
  SELECT p.unit_id, p.map_index, p.side, 'placement' AS source,
         p.class_id AS placed_class_id,
         CASE WHEN p.side = 'player' THEN 1 ELSE 0 END AS is_join
  FROM chapter_placements p JOIN units u ON u.id = p.unit_id
  WHERE p.class_id = 0 OR p.class_id = u.class_id
  UNION ALL
  SELECT ru.unit_id, ru.map_index, ru.side, ru.kind, ru.class_id,
         CASE WHEN ru.kind = 'recruit' AND ru.side = 'player' THEN 1 ELSE 0 END
  FROM chapter_recruit_units ru
),
ranked AS (
  SELECT ev.*, po.position AS story_order,
         COALESCE(po.position, 2147483647) AS rank
  FROM ev LEFT JOIN derived_play_order po ON po.map_index = ev.map_index
)
SELECT 'join' AS kind, unit_id, map_index, story_order, source, placed_class_id
FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY unit_id ORDER BY rank, map_index) rn
      FROM ranked WHERE is_join = 1)
WHERE rn = 1
UNION ALL
SELECT 'appearance', unit_id, map_index, story_order, source, placed_class_id
FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY unit_id ORDER BY rank, map_index) rn
      FROM ranked)
WHERE rn = 1`;

/**
 * Mobility per class, from the ability flags (`classes.mount`) with the two
 * mechanical flier cross-checks (uniform movement costs / total terrain-bonus
 * immunity) catching the airborne monster classes that carry no mount flag.
 * When config/data is absent every mount is NULL and non-fliers read as
 * 'normal' - inferring more from movement costs would be an analysis
 * convention, and conventions do not belong in the db.
 */
export const CLASS_ROLES_VIEW_SQL = `
CREATE VIEW class_roles AS
SELECT id AS class_id,
  CASE
    WHEN mount IN ('wyvern', 'pegasus') THEN 'flying'
    WHEN mount = 'horse' THEN 'mounted'
    WHEN mount = 'armour' THEN 'armour'
    WHEN flying = 1 OR terrain_bonus_immune = 1 THEN 'flying'
    ELSE 'normal'
  END AS mobility
FROM classes
WHERE is_empty = 0`;

/** Every view, in creation order. */
export const VIEWS = [
  ROSTER_VIEW_SQL,
  CLASS_ROLES_VIEW_SQL,
  SUPPORT_EDGES_VIEW_SQL,
  CHAPTER_TRANSITIONS_VIEW_SQL,
  CHAPTER_RECRUITS_VIEW_SQL,
  CHAPTER_RECRUIT_UNITS_VIEW_SQL,
  CHAPTER_GOLD_VIEW_SQL,
  CHAPTER_ITEM_GIVES_VIEW_SQL,
  UNIT_JOINS_VIEW_SQL,
];

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
