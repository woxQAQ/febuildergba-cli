/**
 * Read-only SQL views over the evidence tables.
 *
 * Why views exist at all. The schema's rule is "store facts, derive at query
 * time" (`schema.ts`), and the interesting derivations (a joiner set, a
 * deployment window, a promotion ceiling) are CLI commands because they need
 * the event reach walk or the cap-by-cap growth arithmetic, neither of which
 * SQL can express. But a second class of question is a plain join over three
 * tables that every analysis re-derives: "who is in the army", "which chapters
 * can this unit be fielded in". Written by hand those joins drift; written once
 * here they cannot.
 *
 * The prefix is the contract:
 *   - `derived_*` tables: conclusions SQL cannot recompute (`derived_play_order`,
 *     `derived_unit_stats`). Materialized, trusted as facts.
 *   - `analysis_*` views: trivial derivations over the evidence tables. Cheap to
 *     recompute, so they are views rather than tables; a query may read them
 *     wherever it would have written the join.
 *
 * Views are created after every table is filled (they are not data, and a view
 * whose defining tables do not exist yet fails to compile), so they carry no
 * `TABLE_WRITERS` entry - `pipeline.ts` checks tables, not views.
 */

export interface AnalysisView {
  /** View name; must start with `analysis_`. */
  readonly name: string;
  /** Defining statement, `SELECT` only. */
  readonly sql: string;
  /** One line on what the view answers, for the docs and error messages. */
  readonly summary: string;
}

export const ANALYSIS_VIEWS: readonly AnalysisView[] = [
  {
    name: "analysis_roster",
    summary: "The support-data-bearing units, the pool the `roster` command lists",
    sql: `SELECT id, name, class_id, affinity_id, level
            FROM units
           WHERE has_support_data = 1`,
  },
  {
    name: "analysis_unit_class",
    summary:
      "Each unit joined to its class's promotion linkage, for questions the \
`units` table alone cannot answer (`class_is_promoted` is the unit row's copy)",
    sql: `SELECT u.id AS unit_id,
                 u.name AS unit_name,
                 u.class_id,
                 c.name AS class_name,
                 c.base_class_id,
                 c.sort_order,
                 u.class_is_promoted
            FROM units AS u
            JOIN classes AS c ON c.id = u.class_id`,
  },
  {
    name: "analysis_chapter_slot",
    summary:
      "Each playable chapter with its deployment slots and difficulty level \
adjustments, the denominators behind a window length",
    sql: `SELECT p.map_index,
                 p.position,
                 p.role,
                 ch.chapter_number,
                 ch.title,
                 ch.deploy_slots,
                 ch.deploy_slots_hard,
                 ch.hard_boost,
                 ch.normal_penalty,
                 ch.easy_penalty
            FROM derived_play_order AS p
            JOIN chapters AS ch ON ch.map_index = p.map_index
           WHERE p.playable = 1`,
  },
];
