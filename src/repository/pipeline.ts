/**
 * The write pipeline's contract: one entry per group of tables a single
 * inserter fills, declared in dependency order.
 *
 * Why this exists. `write.ts` inserts in dependency order because foreign
 * keys are enforced with immediate checking, so a parent row must land before
 * anything referencing it. That order used to live in two places - the call
 * sequence inside `writeSnapshot` and the `TABLES` array in `schema.ts` -
 * kept in sync by comments, and a mistake surfaced as a mid-extract FOREIGN
 * KEY failure. `TABLE_WRITERS` (in `write.ts`) is now the single declaration,
 * and {@link assertWritePipeline} checks it against the schema mechanically,
 * so the invariant is enforced rather than documented:
 *
 *   1. every writer fills only tables `TABLES` creates - filling an
 *      unregistered table would fail at INSERT time anyway ("no such table"),
 *      but naming it here catches it before any write runs;
 *   2. every table `TABLES` creates is filled by at least one writer - this is
 *      the "added a table to the schema but forgot the inserter" guard, which
 *      previously stored a silently empty table (and a zero row count);
 *   3. the array order satisfies every foreign key - the previous failure mode,
 *      now caught before BEGIN rather than as a rollback mid-extract.
 *
 * A writer may fill several tables (the class inserter also fills the ability,
 * movement-cost and terrain-bonus children; the world inserter fills condition
 * slots, shops, shop items, map objects and force-sortie), and a table may be
 * filled by several writers (`meta` is written by the metadata, unit and skill
 * writers). Both are properties of the domain, not accidents: grouping is what
 * keeps cross-table invariants - the shop id map in the world writer, the
 * empty-slot count in the unit writer - inside one transaction.
 */

import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import type { ExtractDb } from "./open.ts";
import type { ExtractionSnapshot } from "../model/snapshot.ts";

/** One inserter and the tables it fills. Order in the array is write order. */
export interface TableWriter {
  /** Domain name, for error messages only. */
  readonly name: string;
  /** Tables this writer fills; all must appear in `schema.ts`'s `TABLES`. */
  readonly tables: readonly SQLiteTable[];
  /** Fill them. Runs inside the write transaction, in array order. */
  readonly write: (db: ExtractDb, rom: ExtractionSnapshot) => Promise<void>;
}

/**
 * Verify a writer list against the schema's table list. Throws on the first
 * violation; returns nothing when the pipeline is sound. Pure - it reads the
 * drizzle table configs and nothing else, so it is safe to run per extract.
 */
export function assertWritePipeline(
  writers: readonly TableWriter[],
  allTables: readonly SQLiteTable[],
): void {
  const tableName = (table: SQLiteTable): string => getTableConfig(table).name;
  const created = new Set(allTables.map(tableName));
  /** Table name -> the writer that fills it (the first one, for messages). */
  const filledBy = new Map<string, string>();
  /** Table names covered by the writers processed so far, in order. */
  const written = new Set<string>();

  for (const writer of writers) {
    const own = writer.tables.map(tableName);

    for (const name of own) {
      if (!created.has(name)) {
        throw new Error(
          `write pipeline: writer "${writer.name}" fills "${name}", which schema TABLES does not create`,
        );
      }
    }

    // Foreign keys are enforced immediately, so every referenced table must be
    // written by an earlier writer (or by this one - the class writer fills
    // `classes` before its own children, the event writer fills
    // `event_instructions` before its effect tables).
    for (const table of writer.tables) {
      for (const fk of getTableConfig(table).foreignKeys) {
        const target = tableName(fk.reference().foreignTable);
        if (written.has(target) || own.includes(target)) continue;
        const by = filledBy.get(target);
        throw new Error(
          `write pipeline: writer "${writer.name}" writes "${tableName(table)}" before its ` +
            `foreign target "${target}"` +
            (by === undefined ? ", which no earlier writer fills" : `, written by "${by}"`),
        );
      }
    }

    for (const name of own) {
      written.add(name);
      if (!filledBy.has(name)) filledBy.set(name, writer.name);
    }
  }

  for (const name of created) {
    if (!filledBy.has(name)) {
      throw new Error(`write pipeline: no writer fills "${name}", which schema TABLES creates`);
    }
  }
}
