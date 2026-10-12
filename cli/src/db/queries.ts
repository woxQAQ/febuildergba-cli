/**
 * Opening an extract db and reading the rows the analysis commands need.
 *
 * The db is the single source of truth: analysis reads it, `extract` is the only
 * writer. This file changes no parse rule - it maps rows onto the field
 * semantics the in-memory parser produced, so an analysis module sees the same
 * data either way.
 *
 * **One query per table group, not one load-everything call.** An earlier
 * version returned every table in one object, which forced every command to pay
 * for the 12k-20k `derived_unit_stats` rows and the whole event layer whether or
 * not it read them. Each method here reads its own tables, `openExtract`
 * memoises them, so two commands asking for `units` share one SELECT and a
 * command that never asks never pays.
 *
 * Two jobs beyond the SELECTs:
 *
 *   - **Order is data.** The reach walk and several commands consume rows in
 *     extract order, so tables without a meaningful key are read `ORDER BY
 *     rowid` (insertion order); keyed tables read by their natural key, which
 *     is the table order on both fixtures.
 *   - **Schema guard.** An old extract missing a table or column this loader
 *     reads is reported as "re-run extract", not a `no such column` from
 *     deep inside a query.
 */

import { existsSync } from "node:fs";

import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import type {
  AnalysisChapter,
  AnalysisClass,
  AnalysisUnit,
  ForceSortieRow,
  PlayOrderRows,
  SupportPartnerRow,
} from "../analysis/data.ts";
import type { GameVersion } from "../rom/detect.ts";
import { combineStartingStats } from "../tables/units.ts";
import type {
  ChapterEventSlot,
  EventGraph,
  TracedBlockUnit,
  TracedInstruction,
  TracedScript,
} from "../tables/eventTrace.ts";
import { eventDecodeWarning } from "../tables/eventTrace.ts";
import type { PlayOrderStep } from "../tables/storyPath.ts";
import type { UnitStatRow } from "../tables/unitStats.ts";
import { openDb } from "./index.ts";
import type { OpenDb } from "./index.ts";
import * as t from "./schema.ts";
import { EXTRACT_REVISION } from "./revision.ts";

/** Game ids the extractor can have written (`meta` `rom.version`). */
const GAME_VERSIONS: readonly string[] = ["FE6J", "FE7J", "FE7U", "FE8J", "FE8U"];

/**
 * Every table this file reads, as drizzle tables. The guard below is derived
 * from these rather than transcribed, so a rename in `schema.ts` moves it too.
 * The tables not listed (items, shops, map_objects, skills, terrains, ...) are
 * not requirements: nothing here reads them, so their absence is not this
 * file's to report.
 */
const TABLES_READ: readonly SQLiteTable[] = [
  t.meta,
  t.units,
  t.classes,
  t.chapters,
  t.chapterPlacements,
  t.chapterEventSlots,
  t.eventScripts,
  t.eventInstructions,
  t.eventUnitLoads,
  t.eventCalls,
  t.eventGold,
  t.eventItemGrants,
  t.loadBlockUnits,
  t.derivedPlayOrder,
  t.derivedUnitStats,
  t.forceSortie,
  t.supportPartners,
];

/**
 * Table name -> its SQL column names, from the drizzle schema. Full table
 * definitions, not the columns a given SELECT touches: a superset, so a stale
 * extract is caught even when the reader happens not to name the column.
 */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  TABLES_READ.map((table) => {
    const config = getTableConfig(table);
    return [config.name, config.columns.map((c) => c.name)];
  }),
);

const EXTRACT_HINT = "run `fe-rom extract <rom.gba>` first";

/** One line, exit 1 via `index.ts` - the same treatment as an unreadable ROM. */
function notAnExtractDb(path: string, why: string): Error {
  return new Error(`${path}: ${why} - ${EXTRACT_HINT}`);
}

/**
 * The db is an extract but predates this build; distinguished so the loader
 * does not re-wrap it as "not a database".
 */
class SchemaMismatchError extends Error {}

/**
 * Verify the db carries every table/column this file reads. Throws a one-line
 * {@link SchemaMismatchError} naming the first few gaps; meant for dbs written
 * by an older extract, which is a rebuildable artifact (the schema has no
 * migrations).
 */
function assertExtractSchema(sqlite: OpenDb["sqlite"], path: string): void {
  const tables = new Set(
    (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) {
      missing.push(table);
      continue;
    }
    // Table names are our own constants, safe to interpolate.
    const present = new Set(
      (
        sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join(", ");
    const more = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
    throw new SchemaMismatchError(
      `${path}: database predates this build (missing ${shown}${more}) - ` +
        "re-run `fe-rom extract` to rebuild it",
    );
  }
}

/** `rowid` = insertion order, which the reach walk and several commands consume. */
const ROW_ORDER = sql`rowid`;

/**
 * An open extract db, with one memoised query per table group.
 *
 * Methods are async because drizzle is; each one runs at most one SELECT per
 * table per handle. Callers must {@link ExtractHandle.close} it.
 */
export interface ExtractHandle {
  /** The ROM's game id (`meta` `rom.version`), for the per-version formula branches. */
  game(): Promise<GameVersion>;
  /** Unit-table order. Empty slots are not persisted; see {@link AnalysisUnit}. */
  units(): Promise<AnalysisUnit[]>;
  /** Class-table order, empty entries included. */
  classes(): Promise<AnalysisClass[]>;
  /** Map-setting order, each with its normal and hard placement blocks. */
  chapters(): Promise<AnalysisChapter[]>;
  /** `derived_play_order`: the steps, and map index -> 1-based position. */
  playOrder(): Promise<PlayOrderRows>;
  /** `force_sortie` records; empty when the game has no such table. */
  forceSortie(): Promise<ForceSortieRow[]>;
  /** `support_partners` rows, in extract (directed-record) order. */
  supportPartners(): Promise<SupportPartnerRow[]>;
  /**
   * The raw event layer, rebuilt from `chapter_event_slots`,
   * `event_instructions` and `load_block_units` in insertion order - the same
   * shape `extractEventTrace` produces in memory, so the reach walk in
   * `tables/eventTrace.ts` runs over either unchanged.
   */
  trace(): Promise<EventGraph>;
  /** `derived_unit_stats` - the same simulator output `populate` computes. */
  unitStats(): Promise<UnitStatRow[]>;
  close(): void;
}

/**
 * Open an extract db read-only. Throws a one-line `Error` (exit 1 in
 * `index.ts`) when the file is missing, is not a database, or is not a current
 * extract.
 */
export function openExtract(path: string): ExtractHandle {
  if (!existsSync(path)) {
    throw notAnExtractDb(path, "no such file; the analysis commands read an extract db");
  }

  let handle: OpenDb;
  try {
    handle = openDb(path, { readOnly: true });
  } catch {
    throw notAnExtractDb(path, "not a database");
  }

  try {
    // The first real read is where "this is not SQLite" surfaces (the driver
    // opens lazily), so the schema probe doubles as the format check.
    try {
      assertExtractSchema(handle.sqlite, path);
      const revision = handle.sqlite
        .prepare("SELECT value FROM meta WHERE key = 'extract.revision'")
        .get() as { value: string } | undefined;
      if (revision?.value !== EXTRACT_REVISION) {
        throw new SchemaMismatchError(
          `${path}: extract revision ${revision?.value ?? "missing"} does not match ` +
            `${EXTRACT_REVISION} - re-run \`fe-rom extract\` to rebuild it`,
        );
      }
    } catch (error) {
      if (error instanceof SchemaMismatchError) throw error;
      throw notAnExtractDb(path, "not a database");
    }
  } catch (error) {
    handle.close();
    throw error;
  }

  const { db } = handle;
  // One entry per table group; `undefined` means "not queried yet".
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit as Promise<T>;
    const started = run();
    cache.set(key, started);
    return started;
  };

  const metaOf = () => once("meta", async () => {
    const rows = await db.select().from(t.meta).all();
    return new Map(rows.map((r) => [r.key, r.value]));
  });
  const requireAvailable = async (key: string): Promise<void> => {
    if ((await metaOf()).get(key) !== "true") {
      throw new Error(
        `${path}: ${key.replace(".available", "")} data is unavailable, not empty - ` +
          "re-run extract with the canonical cli/data resources and a readable chapter table",
      );
    }
  };
  const scriptsOf = () => once("scripts", async (): Promise<TracedScript[]> =>
    db.select().from(t.eventScripts).orderBy(t.eventScripts.id).all());
  const requireEvents = () => once("eventQuality", async (): Promise<void> => {
    await requireAvailable("events.available");
    const scripts = await scriptsOf();
    const warning = eventDecodeWarning(scripts);
    if (warning !== null) console.error(`warning: ${warning}`);
  });

  /** `meta` `rom.version`, validated once for every caller. */
  const gameOf = () => once("game", async (): Promise<GameVersion> => {
    const version = (await metaOf()).get("rom.version");
    if (version === undefined || !GAME_VERSIONS.includes(version)) {
      throw notAnExtractDb(path, "no `rom.version` in `meta`; not an extract db");
    }
    return version as GameVersion;
  });

  /**
   * Class rows. Units need these twice (`startingStats` is class base + unit
   * delta, and the name map enriches unit rows), so the rows are kept as well
   * as the mapped form.
   */
  const classRowsOf = () => once("classRows", () => db.select().from(t.classes).orderBy(t.classes.id).all());

  const classesOf = () => once("classes", async (): Promise<AnalysisClass[]> => {
    const rows = await classRowsOf();
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      mount: c.mount,
      flying: c.flying,
      terrainBonusImmune: c.terrainBonusImmune,
      isEmpty: c.isEmpty,
      promotesToClassId: c.promotesToClassId,
      sortOrder: c.sortOrder,
      classPower: c.classPower,
      abilityFlags: c.abilityFlags,
      caps: {
        hp: c.capHp,
        str: c.capStr,
        skl: c.capSkl,
        spd: c.capSpd,
        def: c.capDef,
        res: c.capRes,
        con: c.capCon,
      },
      promotionBonuses: {
        hp: c.promoHp,
        str: c.promoStr,
        skl: c.promoSkl,
        spd: c.promoSpd,
        def: c.promoDef,
        res: c.promoRes,
      },
    }));
  });

  return {
    game: gameOf,
    classes: classesOf,

    units: () =>
      once("units", async (): Promise<AnalysisUnit[]> => {
        // Classes first: `startingStats` is rebuilt from the class bases plus
        // the unit's signed deltas, via the same `combineStartingStats` the
        // parser uses, and the name map comes from the same rows.
        const classRows = await classRowsOf();
        const classBases = new Map(
          classRows.map((c) => [
            c.id,
            { hp: c.baseHp, str: c.baseStr, skl: c.baseSkl, spd: c.baseSpd, def: c.baseDef, res: c.baseRes, con: c.baseCon },
          ]),
        );
        // Same rule as the parser's `buildClassNameMap`: unnamed classes
        // contribute no name.
        const classNames = new Map(
          classRows.filter((c) => c.name.length > 0).map((c) => [c.id, c.name]),
        );

        // Empty unit slots are not persisted (see schema.ts), so every row here
        // is a real unit; `isEmpty: false` keeps the shared predicates reading
        // the same. Ordered by id - the INTEGER PRIMARY KEY, i.e. the rowid
        // alias, which is the unit-table order on both fixtures (ids are
        // monotonic; a hack that permutes ids inside its unit table would need
        // the index column the schema does not carry).
        const unitRows = await db.select().from(t.units).orderBy(t.units.id).all();
        return unitRows.map((u) => ({
          id: u.id,
          name: u.name,
          classId: u.classId,
          className: classNames.get(u.classId) ?? "",
          attribute: u.affinityId,
          level: u.level,
          isEmpty: false,
          isPromotedClass: u.isPromotedClass,
          hasSupportData: u.hasSupportData,
          growths: {
            hp: u.growthHp,
            str: u.growthStr,
            skl: u.growthSkl,
            spd: u.growthSpd,
            def: u.growthDef,
            res: u.growthRes,
            lck: u.growthLck,
          },
          startingStats: combineStartingStats(
            {
              hp: u.deltaHp,
              str: u.deltaStr,
              skl: u.deltaSkl,
              spd: u.deltaSpd,
              def: u.deltaDef,
              res: u.deltaRes,
              lck: u.deltaLck,
              con: u.deltaCon,
            },
            classBases.get(u.classId),
          ),
        }));
      }),

    chapters: () =>
      once("chapters", async (): Promise<AnalysisChapter[]> => {
        await requireAvailable("chapters.available");
        const placementRows = await db
          .select()
          .from(t.chapterPlacements)
          .orderBy(t.chapterPlacements.mapIndex, t.chapterPlacements.mode, t.chapterPlacements.position)
          .all();
        const chapterRows = await db.select().from(t.chapters).orderBy(t.chapters.mapIndex).all();
        const placementsByChapter = new Map<
          number,
          { normal: AnalysisChapter["placements"]; hard: AnalysisChapter["placements"] }
        >();
        for (const p of placementRows) {
          // "hard" sorts before "normal" alphabetically; the arrays are
          // keyed, so the collection order (normal block first) is rebuilt
          // explicitly below.
          let blocks = placementsByChapter.get(p.mapIndex);
          if (blocks === undefined) {
            blocks = { normal: [], hard: [] };
            placementsByChapter.set(p.mapIndex, blocks);
          }
          blocks[p.mode].push({ unitId: p.unitId, classId: p.classId, side: p.side });
        }
        return chapterRows.map((c) => {
          const blocks = placementsByChapter.get(c.mapIndex) ?? { normal: [], hard: [] };
          return {
            index: c.mapIndex,
            deploySlots: c.deploySlots,
            placements: blocks.normal,
            hardPlacements: blocks.hard,
          };
        });
      }),

    playOrder: () =>
      once("playOrder", async (): Promise<PlayOrderRows> => {
        await requireEvents();
        const rows = await db
          .select()
          .from(t.derivedPlayOrder)
          .orderBy(t.derivedPlayOrder.position)
          .all();
        const steps: PlayOrderStep[] = rows.map((r) => ({
          order: r.position,
          mapIndex: r.mapIndex,
          role: r.role,
          playable: r.playable,
        }));
        return { steps, position: new Map(steps.map((s) => [s.mapIndex, s.order])) };
      }),

    forceSortie: () =>
      once("forceSortie", async () => {
        const rows = await db.select().from(t.forceSortie).orderBy(ROW_ORDER).all();
        return rows.map((r) => ({ unitId: r.unitId, mapIndex: r.mapIndex }));
      }),

    supportPartners: () => once("supportPartners", () => db.select().from(t.supportPartners).orderBy(ROW_ORDER).all()),

    trace: () =>
      once("trace", async (): Promise<EventGraph> => {
        await requireEvents();
        const instructionRows = await db.select().from(t.eventInstructions).orderBy(ROW_ORDER).all();
        const instructions: TracedInstruction[] = instructionRows.map((i) => ({
          scriptId: i.scriptId,
          seq: i.seq,
          address: i.address,
          bytes: i.bytes,
          pattern: i.pattern,
          args: i.args,
          opcode: i.opcode,
          category: i.category,
          loads: [],
          calls: [],
          targetMap: i.targetMap,
          gold: [],
          items: [],
        }));
        const byInstruction = new Map(instructions.map((i) => [`${i.scriptId}:${i.seq}`, i]));
        const instructionOf = (scriptId: number, seq: number): TracedInstruction => {
          const instruction = byInstruction.get(`${scriptId}:${seq}`);
          if (instruction === undefined) throw new Error(`${path}: orphan event effect at ${scriptId}:${seq}`);
          return instruction;
        };
        for (const row of await db.select().from(t.eventUnitLoads).orderBy(ROW_ORDER).all()) {
          instructionOf(row.scriptId, row.seq).loads.push({
            position: row.position, kind: row.kind, blockId: row.blockId,
          });
        }
        for (const row of await db.select().from(t.eventCalls).orderBy(ROW_ORDER).all()) {
          instructionOf(row.scriptId, row.seq).calls.push({
            position: row.position, scriptId: row.targetScriptId,
          });
        }
        for (const row of await db.select().from(t.eventGold).orderBy(ROW_ORDER).all()) {
          instructionOf(row.scriptId, row.seq).gold.push({ offset: row.offset, delta: row.delta });
        }
        for (const row of await db.select().from(t.eventItemGrants).orderBy(ROW_ORDER).all()) {
          instructionOf(row.scriptId, row.seq).items.push({
            position: row.position, itemId: row.itemId, unitId: row.unitId,
          });
        }

        const slotRows = await db.select().from(t.chapterEventSlots).orderBy(ROW_ORDER).all();
        const chapterSlots: ChapterEventSlot[] = slotRows.map((s) => ({
          mapIndex: s.mapIndex,
          slotIndex: s.slotIndex,
          slotKind: s.slotKind,
          position: s.position,
          scriptId: s.scriptId,
          turn:
            s.turnStart === null || s.turnEnd === null
              ? null
              : { start: s.turnStart, end: s.turnEnd, phase: s.turnPhase },
          condFlag: s.condFlag,
        }));

        const blockUnitRows = await db.select().from(t.loadBlockUnits).orderBy(ROW_ORDER).all();
        const loadBlockUnits: TracedBlockUnit[] = blockUnitRows.map((u) => ({
          blockId: u.blockId,
          position: u.position,
          unitId: u.unitId,
          classId: u.classId,
          level: u.level,
          side: u.side,
          autolevel: u.autolevel ? 1 : 0,
          x: u.x,
          y: u.y,
          items: u.items,
          ext: u.ext,
        }));

        return { scripts: await scriptsOf(), instructions, chapterSlots, loadBlockUnits };
      }),

    unitStats: () =>
      once("unitStats", async (): Promise<UnitStatRow[]> => {
        await requireEvents();
        const rows = await db.select().from(t.derivedUnitStats).orderBy(ROW_ORDER).all();
        return rows.map((r) => ({
          mapIndex: r.mapIndex,
          difficulty: r.difficulty,
          source: r.source,
          sourceId: r.sourceId,
          position: r.position,
          unitId: r.unitId,
          classId: r.classId,
          side: r.side,
          shownLevel: r.shownLevel,
          levelDelta: r.levelDelta,
          level: r.level,
          levelUnderflow: r.levelUnderflow,
          autolevel: r.autolevel,
          growLevel: r.growLevel,
          promoted: r.promoted,
          stats: {
            hp: r.statHp,
            str: r.statStr,
            skl: r.statSkl,
            spd: r.statSpd,
            def: r.statDef,
            res: r.statRes,
            lck: r.statLck,
            con: r.statCon,
          },
        }));
      }),

    close: () => handle.close(),
  };
}
