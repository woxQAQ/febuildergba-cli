/**
 * Opening an extract db and reading snapshot records.
 *
 * This module validates the storage contract and maps columns to records.
 * Analysis chooses its inputs and interprets data availability and quality.
 *
 * **One query per table group, not one load-everything call.** An earlier
 * version returned every table in one object, which forced every command to pay
 * for the 12k-20k `derived_unit_stats` rows and the whole event layer whether or
 * not it read them. Each method here reads its own tables, `openExtract`
 * memoises them, so two commands asking for `units` share one SELECT and a
 * command that never asks never pays. A failed query is evicted rather than
 * cached: a rejection must not outlive the call that caused it, or one
 * transient failure would poison every later read of that table group.
 *
 * Two jobs beyond the SELECTs:
 *
 *   - **Order comes from keys, never `rowid`.** Every SELECT orders by an
 *     explicit key; the rule and its rationale are stated once in `schema.ts`.
 *     The comments at each query say why that key is the right order.
 *   - **Schema guard.** An old extract missing a table or column this loader
 *     reads is reported as "re-run extract", not a `no such column` from
 *     deep inside a query.
 */

import { existsSync } from "node:fs";

import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import type {
  ChapterRecord,
  ClassBranchRow,
  ClassRecord,
  UnitRecord,
  ForceSortieRow,
  PlayOrderRows,
  SupportPartnerRow,
} from "../model/records.ts";
import type { GameVersion } from "../model/game.ts";
import type {
  ChapterEventSlot,
  EventGraph,
  TracedBlockUnit,
  TracedInstruction,
  TracedScript,
} from "../model/events.ts";
import type { PlayOrderStep } from "../model/storyPath.ts";
import type { DebugMapRecord } from "../model/debugMap.ts";
import type { UnitStatRow } from "../model/stats.ts";
import { openDb } from "./open.ts";
import type { OpenDb } from "./open.ts";
import * as t from "./schema.ts";

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
  t.classBranches,
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
function notAnExtractDb(path: string, why: string, cause?: unknown): Error {
  return new Error(`${path}: ${why} - ${EXTRACT_HINT}`, { cause });
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

/**
 * An open extract db, with one memoised query per table group.
 *
 * Methods are async because drizzle is; each one runs at most one SELECT per
 * table per handle. Callers must {@link ExtractHandle.close} it.
 */
export interface ExtractHandle {
  /** Availability flags written by extraction, without interpreting empty rows. */
  availability(): Promise<{ chapters: boolean; events: boolean }>;
  /** The ROM's game id (`meta` `rom.version`), for the per-version formula branches. */
  game(): Promise<GameVersion>;
  /** Unit-table order. Empty slots are not persisted; stats remain signed deltas. */
  units(): Promise<UnitRecord[]>;
  /** Class-table order, empty entries included. */
  classes(): Promise<ClassRecord[]>;
  /** Map-setting order, each with its normal and hard placement blocks. */
  chapters(): Promise<ChapterRecord[]>;
  /** `derived_play_order`: the steps, and map index -> 1-based position. */
  playOrder(): Promise<PlayOrderRows>;
  /**
   * `meta` `debugMaps`: debug (developer) maps - real rows no playthrough
   * visits. Empty when the ROM has none, and also when the db predates the
   * key (a rebuildable artifact: re-extract to get the exclusion). Callers
   * treat the records as a fact about the ROM, not as a quality signal.
   */
  debugMaps(): Promise<readonly DebugMapRecord[]>;
  /** `force_sortie` records; empty when the game has no such table. */
  forceSortie(): Promise<ForceSortieRow[]>;
  /** `support_partners` rows, in extract (directed-record) order. */
  supportPartners(): Promise<SupportPartnerRow[]>;
  /**
   * `class_branches` rows: the CC menu's two promotion targets per class,
   * zeros included. Empty when the game has no such table (FE6/FE7).
   */
  classBranches(): Promise<ClassBranchRow[]>;
  /** Decoding outcomes, without deciding whether an analysis can proceed. */
  scripts(): Promise<TracedScript[]>;
  /**
   * The raw event layer, rebuilt from `chapter_event_slots`,
   * `event_instructions` and `load_block_units` in insertion order - the same
   * shape `extractEventTrace` produces in memory, so the reach walk in
   * `model/events.ts` runs over either unchanged.
   */
  trace(): Promise<EventGraph>;
  /** `derived_unit_stats` - materialized simulator output, never recalculated. */
  unitStats(): Promise<UnitStatRow[]>;
  close(): void;
}

/**
 * Open an extract db read-only. Throws a one-line `Error` (exit 1 in
 * `index.ts`) when the file is missing, is not a database, or does not carry
 * the tables and columns this build reads.
 */
export function openExtract(path: string): ExtractHandle {
  if (!existsSync(path)) {
    throw notAnExtractDb(path, "no such file; the analysis commands read an extract db");
  }

  let handle: OpenDb;
  try {
    handle = openDb(path, { readOnly: true });
  } catch (error) {
    throw notAnExtractDb(path, "not a database", error);
  }

  try {
    // The first real read is where "this is not SQLite" surfaces (the driver
    // opens lazily), so the schema probe doubles as the format check. There is
    // no revision counter: an extract is a rebuildable artifact, and the guard
    // below already rejects anything predating this build's storage contract.
    try {
      assertExtractSchema(handle.sqlite, path);
    } catch (error) {
      if (error instanceof SchemaMismatchError) throw error;
      throw notAnExtractDb(path, "not a database", error);
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
    // A failure is not a result. Evict it, so the next caller re-runs the query
    // instead of replaying this one stale rejection forever: the handle is
    // long-lived (one command session) and the rejection may be transient
    // (SQLITE_BUSY) or the caller may recover. The identity check keeps a
    // retry that already replaced the entry from being evicted by the older
    // promise's late rejection. `started` is returned untouched, so every
    // current caller still sees the error.
    started.then(undefined, () => {
      if (cache.get(key) === started) cache.delete(key);
    });
    return started;
  };

  const metaOf = () =>
    once("meta", async () => {
      const rows = await db.select().from(t.meta).all();
      return new Map(rows.map((r) => [r.key, r.value]));
    });

  /**
   * A `meta` flag this build always writes. A missing key is a db predating
   * the flag and a value other than "true"/"false" is a corrupt one; both fail
   * the command rather than reading as `false`, which used to make a broken
   * extract indistinguishable from "no chapters".
   */
  const metaBool = (meta: Map<string, string>, key: string): boolean => {
    const raw = meta.get(key);
    if (raw === undefined) {
      throw notAnExtractDb(path, `no \`${key}\` in \`meta\`; not an extract db`);
    }
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw notAnExtractDb(path, `malformed \`meta\` \`${key}\` value ${JSON.stringify(raw)}`);
  };
  const scriptsOf = () =>
    once("scripts", async (): Promise<TracedScript[]> =>
      db.select().from(t.eventScripts).orderBy(t.eventScripts.id).all(),
    );

  /** `meta` `rom.version`, validated once for every caller. */
  const gameOf = () =>
    once("game", async (): Promise<GameVersion> => {
      const version = (await metaOf()).get("rom.version");
      if (version === undefined || !GAME_VERSIONS.includes(version)) {
        throw notAnExtractDb(path, "no `rom.version` in `meta`; not an extract db");
      }
      return version as GameVersion;
    });

  /**
   * Class rows are shared by the class mapping and the unit-name join.
   */
  const classRowsOf = () =>
    once("classRows", () => db.select().from(t.classes).orderBy(t.classes.id).all());

  const classesOf = () =>
    once("classes", async (): Promise<ClassRecord[]> => {
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
        weaponLevels: [
          c.wlSword,
          c.wlLance,
          c.wlAxe,
          c.wlBow,
          c.wlStaff,
          c.wlAnima,
          c.wlLight,
          c.wlDark,
        ] as [number, number, number, number, number, number, number, number],
        specialAction: c.specialAction,
        bases: {
          hp: c.baseHp,
          str: c.baseStr,
          skl: c.baseSkl,
          spd: c.baseSpd,
          def: c.baseDef,
          res: c.baseRes,
          con: c.baseCon,
        },
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
    availability: async () => {
      const meta = await metaOf();
      return {
        chapters: metaBool(meta, "chapters.available"),
        events: metaBool(meta, "events.available"),
      };
    },
    game: gameOf,
    classes: classesOf,
    scripts: scriptsOf,

    units: () =>
      once("units", async (): Promise<UnitRecord[]> => {
        // Join names from stored class rows; signed deltas remain unmodified.
        const classRows = await classRowsOf();
        // Same rule as the parser's `buildClassNameMap`: unnamed classes
        // contribute no name.
        const classNames = new Map(
          classRows.filter((c) => c.name.length > 0).map((c) => [c.id, c.name]),
        );

        // Empty unit slots are not persisted (see schema.ts), so every row here
        // is a real unit; `isEmpty: false` keeps the shared predicates reading
        // the same. Ordered by id: it is the INTEGER PRIMARY KEY (so the sort
        // is a key sort, not rowid, and VACUUM cannot disturb it) and the key
        // every other table references units by - support partners,
        // placements, item grants and unit stats all join on it, which makes
        // id order the canonical roster order rather than an arbitrary one.
        const unitRows = await db.select().from(t.units).orderBy(t.units.id).all();
        return unitRows.map((u) => ({
          id: u.id,
          name: u.name,
          classId: u.classId,
          className: classNames.get(u.classId) ?? "",
          affinityId: u.affinityId,
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
          stats: {
            hp: u.deltaHp,
            str: u.deltaStr,
            skl: u.deltaSkl,
            spd: u.deltaSpd,
            def: u.deltaDef,
            res: u.deltaRes,
            lck: u.deltaLck,
            con: u.deltaCon,
          },
        }));
      }),

    chapters: () =>
      once("chapters", async (): Promise<ChapterRecord[]> => {
        const placementRows = await db
          .select()
          .from(t.chapterPlacements)
          .orderBy(
            t.chapterPlacements.mapIndex,
            t.chapterPlacements.mode,
            t.chapterPlacements.position,
          )
          .all();
        const chapterRows = await db.select().from(t.chapters).orderBy(t.chapters.mapIndex).all();
        const placementsByChapter = new Map<
          number,
          { normal: ChapterRecord["placements"]; hard: ChapterRecord["placements"] }
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
          blocks[p.mode].push({
            unitId: p.unitId,
            classId: p.classId,
            side: p.side,
            level: p.level,
            items: p.items,
          });
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

    debugMaps: () =>
      once("debugMaps", async (): Promise<readonly DebugMapRecord[]> => {
        const raw = (await metaOf()).get("debugMaps");
        // Absent key: a db predating the build reads as no debug maps.
        if (raw === undefined) return [];
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          // A value that is there but does not parse is corruption, and a
          // silent `[]` here would drop the debug-map exclusion without a
          // trace - the failure mode the write side works to avoid.
          throw notAnExtractDb(path, "malformed `meta` `debugMaps` (not JSON)", error);
        }
        if (!Array.isArray(parsed)) {
          throw notAnExtractDb(path, "malformed `meta` `debugMaps` (not an array)");
        }
        return parsed.map((r) => {
          if (
            typeof r === "object" &&
            r !== null &&
            typeof (r as DebugMapRecord).mapIndex === "number" &&
            typeof (r as DebugMapRecord).reason === "string"
          ) {
            return r as DebugMapRecord;
          }
          throw notAnExtractDb(path, `malformed \`meta\` \`debugMaps\` entry ${JSON.stringify(r)}`);
        });
      }),

    forceSortie: () =>
      once("forceSortie", async () => {
        // Primary-key order: consumers index these rows by unit and sort
        // their own output, so this read order is only a deterministic tiebreak.
        const rows = await db
          .select()
          .from(t.forceSortie)
          .orderBy(t.forceSortie.unitId, t.forceSortie.route, t.forceSortie.mapIndex)
          .all();
        return rows.map((r) => ({ unitId: r.unitId, mapIndex: r.mapIndex }));
      }),

    supportPartners: () =>
      // Primary-key order; the `supports` command dedups into a map and sorts
      // its output itself.
      once("supportPartners", () =>
        db
          .select()
          .from(t.supportPartners)
          .orderBy(t.supportPartners.unitId, t.supportPartners.partnerId)
          .all(),
      ),

    classBranches: () =>
      // Class-id order: the promotion graph keys on the base class, and a
      // dense table over class ids reads back in the order it was written.
      once("classBranches", async () => {
        const rows = await db
          .select()
          .from(t.classBranches)
          .orderBy(t.classBranches.classId)
          .all();
        return rows.map((r) => ({ classId: r.classId, branch1: r.branch1, branch2: r.branch2 }));
      }),

    trace: () =>
      once("trace", async (): Promise<EventGraph> => {
        // Key order, not rowid: the extractor assigns script ids FIFO (a
        // CALL-discovered helper gets the next id after the ones already
        // queued) and decodes in queue order, so `(script_id, seq)` is exactly
        // the decode order - and it survives a VACUUM, which rowid does not.
        const instructionRows = await db
          .select()
          .from(t.eventInstructions)
          .orderBy(t.eventInstructions.scriptId, t.eventInstructions.seq)
          .all();
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
          if (instruction === undefined)
            throw new Error(`${path}: orphan event effect at ${scriptId}:${seq}`);
          return instruction;
        };
        // Effect children order by (script, instruction, operand): the writer
        // emits them while walking one instruction's operands in order, so the
        // key order is the insertion order the walks below rebuild.
        for (const row of await db
          .select()
          .from(t.eventUnitLoads)
          .orderBy(t.eventUnitLoads.scriptId, t.eventUnitLoads.seq, t.eventUnitLoads.position)
          .all()) {
          instructionOf(row.scriptId, row.seq).loads.push({
            position: row.position,
            kind: row.kind,
            blockId: row.blockId,
          });
        }
        for (const row of await db
          .select()
          .from(t.eventCalls)
          .orderBy(t.eventCalls.scriptId, t.eventCalls.seq, t.eventCalls.position)
          .all()) {
          instructionOf(row.scriptId, row.seq).calls.push({
            position: row.position,
            scriptId: row.targetScriptId,
          });
        }
        for (const row of await db
          .select()
          .from(t.eventGold)
          .orderBy(t.eventGold.scriptId, t.eventGold.seq, t.eventGold.offset)
          .all()) {
          instructionOf(row.scriptId, row.seq).gold.push({ offset: row.offset, delta: row.delta });
        }
        for (const row of await db
          .select()
          .from(t.eventItemGrants)
          .orderBy(t.eventItemGrants.scriptId, t.eventItemGrants.seq, t.eventItemGrants.position)
          .all()) {
          instructionOf(row.scriptId, row.seq).items.push({
            position: row.position,
            itemId: row.itemId,
            unitId: row.unitId,
          });
        }

        // Chapter slots seed the reach walk in this order (chapters in table
        // order, then slot index, then row), which is the key order: the
        // extractor walks the map-setting rows in index order and each
        // chapter's condition pointers in slot order.
        const slotRows = await db
          .select()
          .from(t.chapterEventSlots)
          .orderBy(
            t.chapterEventSlots.mapIndex,
            t.chapterEventSlots.slotIndex,
            t.chapterEventSlots.position,
          )
          .all();
        const turnOf = (
          s: typeof t.chapterEventSlots.$inferSelect,
        ): NonNullable<ChapterEventSlot["turn"]> | null => {
          if (s.turnStart === null) return null;
          if (s.turnEnd === null) {
            throw new Error(
              `${path}: event slot ${s.mapIndex}:${s.slotIndex} has turn_start ${s.turnStart} ` +
                "with a null turn_end",
            );
          }
          return { start: s.turnStart, end: s.turnEnd, phase: s.turnPhase };
        };
        // A TALK record carries both ids or neither: the pair is one fact, so a
        // half-written pair is a broken artifact rather than a partial pair.
        const talkOf = (
          s: typeof t.chapterEventSlots.$inferSelect,
        ): NonNullable<ChapterEventSlot["talk"]> | null => {
          if (s.talkUnitFrom === null && s.talkUnitTo === null) return null;
          if (s.talkUnitFrom === null || s.talkUnitTo === null) {
            throw new Error(
              `${path}: event slot ${s.mapIndex}:${s.slotIndex} has talk_unit_from ` +
                `${s.talkUnitFrom} with talk_unit_to ${s.talkUnitTo}`,
            );
          }
          return { from: s.talkUnitFrom, to: s.talkUnitTo };
        };
        const chapterSlots: ChapterEventSlot[] = slotRows.map((s) => ({
          mapIndex: s.mapIndex,
          slotIndex: s.slotIndex,
          slotKind: s.slotKind,
          position: s.position,
          scriptId: s.scriptId,
          turn: turnOf(s),
          talk: talkOf(s),
          condFlag: s.condFlag,
        }));

        // Load blocks are discovered in id order and their units read in
        // position order, so (block_id, position) is the insertion order.
        const blockUnitRows = await db
          .select()
          .from(t.loadBlockUnits)
          .orderBy(t.loadBlockUnits.blockId, t.loadBlockUnits.position)
          .all();
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
        // Primary-key order. The row order of this table carries no meaning -
        // `expcurve` only sums and counts these rows - so the key is just a
        // deterministic tiebreak that a VACUUM cannot disturb.
        const rows = await db
          .select()
          .from(t.derivedUnitStats)
          .orderBy(
            t.derivedUnitStats.mapIndex,
            t.derivedUnitStats.difficulty,
            t.derivedUnitStats.source,
            t.derivedUnitStats.sourceId,
            t.derivedUnitStats.position,
          )
          .all();
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
