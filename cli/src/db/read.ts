/**
 * Loading an extract database back into the shape the analysis commands
 * compute over ({@link AnalysisData}). The db is the single source of truth:
 * analysis reads it, `extract` is the only writer. This file is read-only -
 * it changes no parse rule; it maps rows onto the same field semantics the
 * in-memory parser produced, so the analysis modules see the same data either
 * way.
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

import type {
  AnalysisChapter,
  AnalysisClass,
  AnalysisData,
  AnalysisUnit,
} from "../analysis/data.ts";
import type { GameVersion } from "../rom/detect.ts";
import { combineStartingStats } from "../tables/units.ts";
import type { ChapterEventSlot, TracedBlockUnit, TracedInstruction } from "../tables/eventTrace.ts";
import type { PlayOrderStep } from "../tables/storyPath.ts";
import type { UnitStatRow } from "../tables/unitStats.ts";
import { openDb } from "./index.ts";
import type { OpenDb } from "./index.ts";
import * as t from "./schema.ts";

/** Game ids the extractor can have written (`meta` `rom.version`). */
const GAME_VERSIONS: readonly string[] = ["FE6J", "FE7J", "FE7U", "FE8J", "FE8U"];

/**
 * Every table and column {@link loadAnalysisData} reads. Checked up front so
 * a db written by an older extract fails with "re-run extract" instead of a
 * driver error mid-load.
 */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  meta: ["key", "value"],
  units: [
    "id",
    "name",
    "class_id",
    "is_promoted_class",
    "affinity_id",
    "level",
    "delta_hp",
    "delta_str",
    "delta_skl",
    "delta_spd",
    "delta_def",
    "delta_res",
    "delta_lck",
    "delta_con",
    "growth_hp",
    "growth_str",
    "growth_skl",
    "growth_spd",
    "growth_def",
    "growth_res",
    "growth_lck",
    "has_support_data",
  ],
  classes: [
    "id",
    "name",
    "promotes_to_class_id",
    "sort_order",
    "class_power",
    "base_hp",
    "base_str",
    "base_skl",
    "base_spd",
    "base_def",
    "base_res",
    "base_con",
    "cap_hp",
    "cap_str",
    "cap_skl",
    "cap_spd",
    "cap_def",
    "cap_res",
    "cap_con",
    "promo_hp",
    "promo_str",
    "promo_skl",
    "promo_spd",
    "promo_def",
    "promo_res",
    "ability_flags",
    "mount",
    "flying",
    "terrain_bonus_immune",
    "is_empty",
  ],
  chapters: ["map_index", "deploy_slots"],
  chapter_placements: ["map_index", "mode", "position", "unit_id", "class_id", "side"],
  chapter_event_slots: [
    "map_index",
    "slot_index",
    "slot_kind",
    "position",
    "script_id",
    "turn_start",
    "turn_end",
    "turn_phase",
    "cond_flag",
  ],
  event_instructions: [
    "script_id",
    "seq",
    "opcode",
    "category",
    "load_kind",
    "block_id",
    "call_script_id",
    "target_map",
    "gold_delta",
    "item_id",
    "give_unit_id",
  ],
  load_blocks: ["id"],
  load_block_units: [
    "block_id",
    "position",
    "unit_id",
    "class_id",
    "level",
    "side",
    "autolevel",
    "x",
    "y",
    "items",
    "ext",
  ],
  derived_play_order: ["map_index", "position", "role", "playable"],
  derived_unit_stats: [
    "map_index",
    "difficulty",
    "source",
    "source_id",
    "position",
    "unit_id",
    "class_id",
    "side",
    "shown_level",
    "level_delta",
    "level",
    "level_underflow",
    "autolevel",
    "grow_level",
    "promoted",
    "stat_hp",
    "stat_str",
    "stat_skl",
    "stat_spd",
    "stat_def",
    "stat_res",
    "stat_lck",
    "stat_con",
  ],
  force_sortie: ["unit_id", "map_index"],
  support_partners: ["unit_id", "partner_id", "initial", "growth"],
};

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
 * Verify the db carries every table/column the loader reads. Throws a
 * one-line {@link SchemaMismatchError} naming the first few gaps; meant for
 * dbs written by an older extract, which is a rebuildable artifact (the
 * schema has no migrations).
 */
function assertAnalysisSchema(sqlite: OpenDb["sqlite"], path: string): void {
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
 * Open an extract db read-only and load everything the analysis commands
 * need. Throws a one-line `Error` (exit 1 in `index.ts`) when the file is
 * missing, is not a database, or is not a current extract.
 */
export async function loadAnalysisData(path: string): Promise<AnalysisData> {
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
      assertAnalysisSchema(handle.sqlite, path);
    } catch (error) {
      if (error instanceof SchemaMismatchError) throw error;
      throw notAnExtractDb(path, "not a database");
    }

    const { db } = handle;

    const metaRows = await db.select().from(t.meta).all();
    const version = metaRows.find((r) => r.key === "rom.version")?.value;
    if (version === undefined || !GAME_VERSIONS.includes(version)) {
      throw notAnExtractDb(path, "no `rom.version` in `meta`; not an extract db");
    }
    const game = version as GameVersion;

    // Classes before units: `startingStats` is rebuilt from the class bases
    // plus the unit's signed deltas, via the same `combineStartingStats` the
    // parser uses.
    const classRows = await db.select().from(t.classes).orderBy(t.classes.id).all();
    const classes: AnalysisClass[] = classRows.map((c) => ({
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
    const classBases = new Map(
      classRows.map((c) => [
        c.id,
        {
          hp: c.baseHp,
          str: c.baseStr,
          skl: c.baseSkl,
          spd: c.baseSpd,
          def: c.baseDef,
          res: c.baseRes,
          con: c.baseCon,
        },
      ]),
    );
    // Same rule as the parser's `buildClassNameMap`: unnamed classes contribute
    // no name.
    const classNames = new Map(
      classRows.filter((c) => c.name.length > 0).map((c) => [c.id, c.name]),
    );

    // Empty unit slots are not persisted (see schema.ts), so every row here is
    // a real unit; `isEmpty: false` keeps the shared predicates reading the
    // same. Ordered by id - the INTEGER PRIMARY KEY, i.e. the rowid alias,
    // which is the unit-table order on both fixtures (ids are monotonic; a
    // hack that permutes ids inside its unit table would need the index
    // column the schema does not carry).
    const unitRows = await db.select().from(t.units).orderBy(t.units.id).all();
    const units: AnalysisUnit[] = unitRows.map((u) => {
      const deltas = {
        hp: u.deltaHp,
        str: u.deltaStr,
        skl: u.deltaSkl,
        spd: u.deltaSpd,
        def: u.deltaDef,
        res: u.deltaRes,
        lck: u.deltaLck,
        con: u.deltaCon,
      };
      return {
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
        startingStats: combineStartingStats(deltas, classBases.get(u.classId)),
      };
    });

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
      // "hard" sorts before "normal" alphabetically; the arrays are keyed, so
      // the collection order (normal block first) is rebuilt explicitly below.
      let blocks = placementsByChapter.get(p.mapIndex);
      if (blocks === undefined) {
        blocks = { normal: [], hard: [] };
        placementsByChapter.set(p.mapIndex, blocks);
      }
      blocks[p.mode].push({ unitId: p.unitId, classId: p.classId, side: p.side });
    }
    const chapters: AnalysisChapter[] = chapterRows.map((c) => {
      const blocks = placementsByChapter.get(c.mapIndex) ?? { normal: [], hard: [] };
      return {
        index: c.mapIndex,
        deploySlots: c.deploySlots,
        placements: blocks.normal,
        hardPlacements: blocks.hard,
      };
    });

    const playOrderRows = await db
      .select()
      .from(t.derivedPlayOrder)
      .orderBy(t.derivedPlayOrder.position)
      .all();
    const steps: PlayOrderStep[] = playOrderRows.map((r) => ({
      order: r.position,
      mapIndex: r.mapIndex,
      role: r.role,
      playable: r.playable,
    }));

    const forceSortieRows = await db.select().from(t.forceSortie).orderBy(ROW_ORDER).all();
    const supportPartnerRows = await db.select().from(t.supportPartners).orderBy(ROW_ORDER).all();

    const instructionRows = await db.select().from(t.eventInstructions).orderBy(ROW_ORDER).all();
    const instructions: TracedInstruction[] = instructionRows.map((i) => ({
      scriptId: i.scriptId,
      seq: i.seq,
      opcode: i.opcode,
      category: i.category,
      loadKind: i.loadKind,
      blockId: i.blockId,
      callScriptId: i.callScriptId,
      targetMap: i.targetMap,
      goldDelta: i.goldDelta,
      itemId: i.itemId,
      giveUnitId: i.giveUnitId,
    }));

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

    const unitStatRows = await db.select().from(t.derivedUnitStats).orderBy(ROW_ORDER).all();
    const unitStats: UnitStatRow[] = unitStatRows.map((r) => ({
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

    return {
      game,
      units,
      classes,
      chapters,
      playOrder: {
        steps,
        position: new Map(steps.map((s) => [s.mapIndex, s.order])),
      },
      forceSortie: forceSortieRows.map((r) => ({ unitId: r.unitId, mapIndex: r.mapIndex })),
      supportPartners: supportPartnerRows,
      trace: { instructions, chapterSlots, loadBlockUnits },
      unitStats,
    };
  } finally {
    handle.close();
  }
}
