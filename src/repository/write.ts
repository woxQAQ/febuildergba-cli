/**
 * Persist a complete snapshot. All inserts go through the drizzle schema
 * (`schema.ts`), so a column
 * typo or wrong value type is a compile error, not a SQLite error mid-extract.
 * Writes run in one transaction; a failure rolls the whole db back.
 *
 * Inserts are chunked, not one statement per row - see `insertInChunks`.
 *
 * Foreign keys are enforced on this connection and the insert order is the
 * dependency order: declared once in {@link TABLE_WRITERS} below, checked
 * against the schema by {@link assertWritePipeline} before the transaction
 * opens. Enforcement is immediate (not deferred), so a dangling reference
 * fails the extract instead of silently storing null.
 */

import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import type { ExtractionSnapshot } from "../model/snapshot.ts";
import type { EventTrace } from "../model/events.ts";
import type { UnitStatRow } from "../model/stats.ts";
import { createTablesSql } from "./ddl.ts";
import type { ExtractDb, OpenDb } from "./open.ts";
import type { TableWriter } from "./pipeline.ts";
import { assertWritePipeline } from "./pipeline.ts";
import * as t from "./schema.ts";

export interface WriteReceipt {
  /** Row count per table, measured after the commit. */
  readonly tables: Readonly<Record<string, number>>;
}

export async function writeSnapshot(
  handle: OpenDb,
  rom: ExtractionSnapshot,
): Promise<WriteReceipt> {
  const { db, sqlite } = handle;
  // The write order is data, checked here before anything is written: a
  // writer filling an unregistered table, a registered table with no writer,
  // or a foreign target written after its referrer all fail now rather than
  // mid-transaction. See `pipeline.ts`.
  assertWritePipeline(TABLE_WRITERS, t.TABLES);

  // The writer rebuilds from empty; it never merges into an existing db. The
  // check turns the first CREATE TABLE's "table meta already exists" into a
  // message that says what the caller did wrong. `commands/extract.ts` stays
  // the intended caller: it builds a scratch file and renames it over the
  // output, so it always hands this function a fresh one.
  const existing = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  if (existing.length > 0) {
    throw new Error(
      `${handle.path}: already carries ${existing.length} table(s) (${existing[0]!.name}, ...); ` +
        "writeSnapshot rebuilds from empty, so pass a fresh file",
    );
  }

  for (const statement of createTablesSql(t.TABLES)) sqlite.exec(statement);

  // Foreign-key enforcement is a per-connection setting. SQLite's own default
  // is OFF; `node:sqlite` happens to enable it, but that is the driver's
  // choice, not a guarantee - so it is set explicitly and the result is
  // asserted rather than assumed. It is a no-op inside a transaction, so it
  // runs before BEGIN.
  sqlite.exec("PRAGMA foreign_keys = ON");
  const fkState = sqlite.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  if (fkState.foreign_keys !== 1) {
    throw new Error("could not enable SQLite foreign-key enforcement on the write connection");
  }

  sqlite.exec("BEGIN");
  try {
    // Dependency order is TABLE_WRITERS' array order (asserted above): every
    // parent table is written before the tables that reference it, because
    // enforcement is immediate (not deferred).
    for (const writer of TABLE_WRITERS) {
      await writer.write(db, rom);
    }
    sqlite.exec("COMMIT");

    // Row counts measured, not tallied: the number reported is the number
    // that actually landed.
    const tables: Record<string, number> = {};
    for (const table of t.TABLES) {
      const row = await db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .get();
      tables[
        getTableConfig(table).name
      ] = // `count(*)` always yields exactly one row.
        (row as { n: number }).n;
    }
    return { tables };
  } catch (error) {
    // Guarded: a failure after COMMIT (the row-count block above is inside this
    // try) finds no active transaction, and an unconditional ROLLBACK would
    // throw "cannot rollback - no transaction is active" over the real error.
    if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Bound-parameter budget for one INSERT statement.
 *
 * Two ceilings, both respected: SQLite caps variables per statement (999
 * before 3.32, 32766 since - `node:sqlite` ships a current build), and the
 * proxy driver in `open.ts` spreads a statement's parameters onto `stmt.run`,
 * a second reason to keep the count modest. 900 is safe on every SQLite build
 * while still amortising statement preparation across a few dozen rows.
 */
const INSERT_PARAM_BUDGET = 900;

/**
 * Insert `rows` as multi-row statements of at most `INSERT_PARAM_BUDGET`
 * parameters each.
 *
 * Row-by-row inserts made the driver build and execute one statement per
 * row - ~64k per extract, dominated by `class_movement_costs` (23k),
 * `derived_unit_stats` (12k) and `event_instructions` (10k). Chunking keeps
 * the written order identical: a multi-row insert writes its values in array
 * order and the statements run in sequence, so the row order on disk still
 * matches extract order (`read.ts` orders by explicit keys, never `rowid`).
 */
async function insertInChunks<T extends object>(
  rows: readonly T[],
  insertChunk: (chunk: T[]) => unknown,
): Promise<void> {
  if (rows.length === 0) return;
  const width = Object.keys(rows[0]!).length;
  const size = Math.max(1, Math.floor(INSERT_PARAM_BUDGET / width));
  for (let i = 0; i < rows.length; i += size) {
    await insertChunk(rows.slice(i, i + size));
  }
}

async function insertMeta(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const metadata = rom.metadata;
  await db.insert(t.meta).values([
    { key: "rom.path", value: metadata.path },
    { key: "rom.sizeBytes", value: String(metadata.sizeBytes) },
    { key: "rom.gameCode", value: metadata.gameCode },
    { key: "rom.title", value: metadata.title },
    { key: "rom.version", value: metadata.version },
    { key: "rom.displayName", value: metadata.displayName },
    { key: "rom.isMultibyte", value: String(metadata.isMultibyte) },
    // Which skill-system patch family the ROM carries, or "none". Detection
    // only - it gates how the rest of the ROM should be interpreted (a
    // patched ROM relocates other tables), it is not skill data.
    { key: "rom.skillSystem", value: metadata.skillSystem },
    // Which magic-split patch family the ROM carries, or "none". Detection
    // only - it gates how unit/class attack stats must be read (a patched ROM
    // keeps magic out of the strength field), it is not magic data.
    { key: "rom.magicSplit", value: metadata.magicSplit },
    { key: "rom.notes", value: JSON.stringify(metadata.notes) },
    { key: "config.dir", value: metadata.configDir ?? "" },
    { key: "config.language", value: metadata.configLanguage },
    { key: "chapters.available", value: String(rom.chaptersAvailable) },
    {
      key: "events.available",
      value: String(rom.eventsAvailable),
    },
    // `mainPath` is not stored: it is `derived_play_order` filtered to
    // role='main'. `branches` and `closedLoop` are not expressible from the
    // table, so they stay here as run-level facts.
    { key: "playOrder.branches", value: JSON.stringify(rom.playOrder.branches) },
    { key: "playOrder.closedLoop", value: JSON.stringify(rom.playOrder.closedLoop) },
    // Debug maps, as `{mapIndex, reason}` records. The appearance-based
    // analyses drop them; a db predating this build reads as none, which only
    // means "re-extract to get the exclusion".
    { key: "debugMaps", value: JSON.stringify(rom.debugMaps) },
  ]);
}

/** Empty slots (no name, class or level) are skipped; the count lands in meta. */
async function insertUnits(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  let skipped = 0;
  const rows: (typeof t.units.$inferInsert)[] = [];
  for (const u of rom.units) {
    if (u.isEmpty) {
      skipped++;
      continue;
    }
    rows.push({
      id: u.id,
      name: u.name,
      nameTextId: u.nameTextId,
      description: u.description,
      descTextId: u.descriptionTextId,
      classId: u.classId,
      isPromotedClass: u.isPromotedClass,
      mapFaceId: u.mapFaceId,
      portraitId: u.portraitId,
      affinityId: u.affinityId,
      sortOrder: u.sortOrder,
      level: u.level,
      deltaHp: u.stats.hp,
      deltaStr: u.stats.str,
      deltaSkl: u.stats.skl,
      deltaSpd: u.stats.spd,
      deltaDef: u.stats.def,
      deltaRes: u.stats.res,
      deltaLck: u.stats.lck,
      deltaCon: u.stats.con,
      growthHp: u.growths.hp,
      growthStr: u.growths.str,
      growthSkl: u.growths.skl,
      growthSpd: u.growths.spd,
      growthDef: u.growths.def,
      growthRes: u.growths.res,
      growthLck: u.growths.lck,
      growthTotal: u.growthTotal,
      wlSword: u.weaponLevels.sword,
      wlLance: u.weaponLevels.lance,
      wlAxe: u.weaponLevels.axe,
      wlBow: u.weaponLevels.bow,
      wlStaff: u.weaponLevels.staff,
      wlAnima: u.weaponLevels.anima,
      wlLight: u.weaponLevels.light,
      wlDark: u.weaponLevels.dark,
      abilityFlags: u.abilityFlags,
      hasSupportData: u.hasSupportData,
    });
  }
  await insertInChunks(rows, (chunk) => db.insert(t.units).values(chunk));
  await db.insert(t.meta).values({ key: "units.emptySlots", value: String(skipped) });
}

async function insertClasses(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const classRows: (typeof t.classes.$inferInsert)[] = [];
  const flagRows: (typeof t.classAbilityFlags.$inferInsert)[] = [];
  const costRows: (typeof t.classMovementCosts.$inferInsert)[] = [];
  const bonusRows: (typeof t.classTerrainBonuses.$inferInsert)[] = [];
  for (const c of rom.classes) {
    classRows.push({
      id: c.id,
      name: c.name,
      nameTextId: c.nameTextId,
      description: c.description,
      promotesToClassId: c.promotesToClassId,
      sortOrder: c.sortOrder,
      movementRange: c.movementRange,
      movementSpeed: c.movementSpeed,
      classPower: c.classPower,
      baseHp: c.bases.hp,
      baseStr: c.bases.str,
      baseSkl: c.bases.skl,
      baseSpd: c.bases.spd,
      baseDef: c.bases.def,
      baseRes: c.bases.res,
      baseCon: c.bases.con,
      capHp: c.caps.hp,
      capStr: c.caps.str,
      capSkl: c.caps.skl,
      capSpd: c.caps.spd,
      capDef: c.caps.def,
      capRes: c.caps.res,
      capCon: c.caps.con,
      enemyGrowthHp: c.enemyGrowths.hp,
      enemyGrowthStr: c.enemyGrowths.str,
      enemyGrowthSkl: c.enemyGrowths.skl,
      enemyGrowthSpd: c.enemyGrowths.spd,
      enemyGrowthDef: c.enemyGrowths.def,
      enemyGrowthRes: c.enemyGrowths.res,
      enemyGrowthLck: c.enemyGrowths.lck,
      promoHp: c.promotionBonuses.hp,
      promoStr: c.promotionBonuses.str,
      promoSkl: c.promotionBonuses.skl,
      promoSpd: c.promotionBonuses.spd,
      promoDef: c.promotionBonuses.def,
      promoRes: c.promotionBonuses.res,
      wlSword: c.weaponLevels.sword,
      wlLance: c.weaponLevels.lance,
      wlAxe: c.weaponLevels.axe,
      wlBow: c.weaponLevels.bow,
      wlStaff: c.weaponLevels.staff,
      wlAnima: c.weaponLevels.anima,
      wlLight: c.weaponLevels.light,
      wlDark: c.weaponLevels.dark,
      abilityFlags: c.abilityFlags,
      mount: c.mount,
      specialAction: c.specialAction,
      flying: c.flying,
      terrainBonusImmune: c.terrainBonusImmune,
      isEmpty: c.isEmpty,
    });
    for (const flag of c.abilityFlagIds) {
      flagRows.push({ classId: c.id, flag });
    }
    for (const [variant, costs] of [
      ["normal", c.movementCosts],
      ["rain", c.movementCostsRain],
      ["snow", c.movementCostsSnow],
    ] as const) {
      for (const [terrainId, cost] of costs.entries()) {
        costRows.push({ classId: c.id, variant, terrainId, cost });
      }
    }
    if (c.terrainBonuses !== null) {
      for (const [terrainId, avoid] of c.terrainBonuses.avoid.entries()) {
        bonusRows.push({
          classId: c.id,
          terrainId,
          avoid,
          def: c.terrainBonuses.def[terrainId] ?? 0,
          res: c.terrainBonuses.res[terrainId] ?? 0,
        });
      }
    }
  }
  await insertInChunks(classRows, (chunk) => db.insert(t.classes).values(chunk));
  await insertInChunks(flagRows, (chunk) => db.insert(t.classAbilityFlags).values(chunk));
  await insertInChunks(costRows, (chunk) => db.insert(t.classMovementCosts).values(chunk));
  await insertInChunks(bonusRows, (chunk) => db.insert(t.classTerrainBonuses).values(chunk));
}

/**
 * The class-change branch table. Runs after `classes` - every row's class id
 * must exist - and reads no other table. Empty for FE6/FE7, which have no
 * branch table: an empty `class_branches` is the truth there, not a gap.
 */
async function insertClassBranches(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  if (rom.classBranch === null) return;
  const rows: (typeof t.classBranches.$inferInsert)[] = rom.classBranch.entries.map((e) => ({
    classId: e.classId,
    branch1: e.branch1,
    branch2: e.branch2,
  }));
  await insertInChunks(rows, (chunk) => db.insert(t.classBranches).values(chunk));
}

/**
 * Affinities and their bonus table. Every referenced affinity id gets a row,
 * named or not: a unit carrying an unnamed hack affinity is data, not an
 * absence of data. Runs before `units` because support bonuses reference
 * affinities.
 */
async function insertAffinities(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  // Every referenced affinity id gets a row, named or not: a unit carrying
  // an unnamed hack affinity is data, not an absence of data.
  const affinityIds = new Set<number>(rom.affinityNames.keys());
  for (const b of rom.supportBonuses) affinityIds.add(b.affinity);
  for (const u of rom.units) {
    if (u.affinityId !== 0) affinityIds.add(u.affinityId);
  }
  const affinityRows: (typeof t.affinities.$inferInsert)[] = [...affinityIds]
    .sort((a, b) => a - b)
    .map((id) => ({ id, name: rom.affinityNames.get(id) ?? null }));
  await insertInChunks(affinityRows, (chunk) => db.insert(t.affinities).values(chunk));

  const bonusRows: (typeof t.supportBonuses.$inferInsert)[] = rom.supportBonuses.map((b) => ({
    affinityId: b.affinity,
    atkHalf: b.bonuses.atk,
    defHalf: b.bonuses.def,
    hitHalf: b.bonuses.hit,
    avoidHalf: b.bonuses.avoid,
    critHalf: b.bonuses.crit,
    critAvoidHalf: b.bonuses.critAvoid,
  }));
  await insertInChunks(bonusRows, (chunk) => db.insert(t.supportBonuses).values(chunk));
}

/**
 * Per-unit support records and their directed partner rows. Runs after
 * `units`, which both reference.
 */
async function insertSupportLinks(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const entryRows: (typeof t.supportEntries.$inferInsert)[] = [];
  const partnerRows: (typeof t.supportPartners.$inferInsert)[] = [];
  for (const e of rom.supports.entries) {
    entryRows.push({
      unitId: e.unitId,
      declaredCount: e.declaredCount,
      actualCount: e.actualCount,
    });
    for (const p of e.partners) {
      partnerRows.push({
        unitId: e.unitId,
        partnerId: p.unitId,
        initial: p.initial,
        growth: p.growth,
      });
    }
  }
  await insertInChunks(entryRows, (chunk) => db.insert(t.supportEntries).values(chunk));
  await insertInChunks(partnerRows, (chunk) => db.insert(t.supportPartners).values(chunk));
  // The deduplicated pair view is the `supports` command now - nothing to insert.
}

async function insertItemsAndTerrain(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const itemRows: (typeof t.items.$inferInsert)[] = [];
  const effectivenessRows: (typeof t.itemEffectiveness.$inferInsert)[] = [];
  const promotionRows: (typeof t.itemPromotions.$inferInsert)[] = [];
  for (const i of rom.items) {
    itemRows.push({
      id: i.id,
      name: i.name,
      nameTextId: i.nameTextId,
      descTextId: i.descTextId,
      useDescTextId: i.useDescTextId,
      description: i.desc,
      type: i.type,
      typeName: i.typeName,
      attributes: i.attributes,
      sbHp: i.statBonuses?.hp ?? null,
      sbStr: i.statBonuses?.str ?? null,
      sbSkl: i.statBonuses?.skl ?? null,
      sbSpd: i.statBonuses?.spd ?? null,
      sbDef: i.statBonuses?.def ?? null,
      sbRes: i.statBonuses?.res ?? null,
      sbLck: i.statBonuses?.lck ?? null,
      sbMov: i.statBonuses?.mov ?? null,
      sbCon: i.statBonuses?.con ?? null,
      uses: i.uses,
      might: i.might,
      hit: i.hit,
      weight: i.weight,
      crit: i.crit,
      rangeMin: i.rangeMin,
      rangeMax: i.rangeMax,
      weaponRank: i.weaponRank,
      iconId: i.iconId,
      staffEffect: i.staffEffect,
      staffEffectName: i.staffEffectName,
      isPromotionItem: i.isPromotionItem,
      damageBonus: i.damageBonus,
      wexp: i.wexp,
      unitPrice: i.unitPrice,
      isWeapon: i.isWeapon,
    });
    /**
     * The ROM's list can name a class twice (the bow table lists the flier
     * ids 99/100 and 59/60 doubled up); "effective against" is a set, so the
     * duplicates are redundant, not data.
     */
    for (const classId of new Set(i.effectiveness ?? [])) {
      effectivenessRows.push({ itemId: i.id, classId });
    }
    /**
     * The class list is the same for every item sharing an effect code; rows
     * are per item so a query can ask "can this item promote this class"
     * without first mapping item -> code.
     */
    for (const classId of new Set(i.promotionClasses ?? [])) {
      promotionRows.push({ itemId: i.id, classId, effectCode: i.staffEffect });
    }
  }
  await insertInChunks(itemRows, (chunk) => db.insert(t.items).values(chunk));
  await insertInChunks(effectivenessRows, (chunk) => db.insert(t.itemEffectiveness).values(chunk));
  await insertInChunks(promotionRows, (chunk) => db.insert(t.itemPromotions).values(chunk));

  const terrainRows: (typeof t.terrains.$inferInsert)[] = rom.terrainNames.names.map((terrain) => ({
    id: terrain.id,
    name: terrain.name,
    textId: terrain.textId,
    decoded: terrain.decoded,
  }));
  await insertInChunks(terrainRows, (chunk) => db.insert(t.terrains).values(chunk));
}

async function insertChapters(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const chapterRows: (typeof t.chapters.$inferInsert)[] = [];
  const placementRows: (typeof t.chapterPlacements.$inferInsert)[] = [];
  const stepRows: (typeof t.chapterPlacementSteps.$inferInsert)[] = [];
  for (const c of rom.chapters) {
    chapterRows.push({
      mapIndex: c.index,
      chapterNumber: c.chapterNumber,
      titleTextId: c.titleTextId,
      title: c.title,
      weatherId: c.weatherId,
      difficultyRaw: c.difficultyRaw,
      hardBoost: c.hardBoost,
      normalPenalty: c.normalPenalty,
      easyPenalty: c.easyPenalty,
      deploySlots: c.deploySlots,
      deploySlotsHard: c.deploySlotsHard,
    });
    for (const [mode, list] of [
      ["normal", c.placements],
      ["hard", c.hardPlacements],
    ] as const) {
      for (const [position, p] of list.entries()) {
        placementRows.push({
          mapIndex: c.index,
          mode,
          position,
          unitId: p.unitId,
          classId: p.classId,
          commander: p.commander,
          level: p.level,
          side: p.side,
          autolevel: p.autolevel === 1,
          x: p.prePlacementCoord.x,
          y: p.prePlacementCoord.y,
          ext: p.prePlacementCoord.ext,
          items: p.items,
        });
        for (const [step, s] of p.postPlacements.entries()) {
          stepRows.push({
            mapIndex: c.index,
            mode,
            position,
            step,
            x: s.x,
            y: s.y,
            ext: s.ext,
            speed: s.speed,
            unitId: s.unitId,
            wait: s.wait,
          });
        }
      }
    }
  }
  await insertInChunks(chapterRows, (chunk) => db.insert(t.chapters).values(chunk));
  await insertInChunks(placementRows, (chunk) => db.insert(t.chapterPlacements).values(chunk));
  await insertInChunks(stepRows, (chunk) => db.insert(t.chapterPlacementSteps).values(chunk));
}

/**
 * The play order is the one story-path artifact that stays materialized:
 * branch splicing ("a side chapter is played between its branch parent and
 * the next main chapter") is a custom ordering SQL cannot express. The
 * transitions it reads are what the `transitions` command prints over the raw
 * event layer.
 */
async function insertStory(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const rows: (typeof t.derivedPlayOrder.$inferInsert)[] = rom.playOrder.steps.map((step) => ({
    mapIndex: step.mapIndex,
    position: step.order,
    role: step.role,
    playable: step.playable,
  }));
  await insertInChunks(rows, (chunk) => db.insert(t.derivedPlayOrder).values(chunk));
}

/**
 * Skill-system definitions. Empty for a ROM without the patch, which is why
 * the `skills.classSkillExtends` meta flag is written either way - it is the
 * only thing that distinguishes "no skill system" from "a skill system whose
 * learn lists carry no difficulty bits".
 */
async function insertSkillSystem(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const skills = rom.skills;
  if (skills === null) {
    await db.insert(t.meta).values({ key: "skills.classSkillExtends", value: "false" });
    return;
  }
  await db.insert(t.meta).values({
    key: "skills.classSkillExtends",
    value: String(skills.classSkillExtends),
  });

  const skillRows: (typeof t.skills.$inferInsert)[] = skills.skills.map((s) => ({
    id: s.id,
    nameTextId: s.nameTextId,
    name: s.name,
    description: s.description,
    text: s.text,
  }));
  await insertInChunks(skillRows, (chunk) => db.insert(t.skills).values(chunk));
}

/**
 * Skill links per unit and class. Runs after `units` (unit_skills,
 * unit_skill_learn) and `skills` (all four tables) because enforcement is
 * immediate.
 */
async function insertSkillAssignments(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const skills = rom.skills;
  if (skills === null) return;

  const unitSkillRows: (typeof t.unitSkills.$inferInsert)[] = skills.unitSkills.map((a) => ({
    unitId: a.ownerId,
    skillId: a.skillId,
  }));
  await insertInChunks(unitSkillRows, (chunk) => db.insert(t.unitSkills).values(chunk));

  const classSkillRows: (typeof t.classSkills.$inferInsert)[] = skills.classSkills.map((a) => ({
    classId: a.ownerId,
    skillId: a.skillId,
  }));
  await insertInChunks(classSkillRows, (chunk) => db.insert(t.classSkills).values(chunk));

  const unitLearnRows: (typeof t.unitSkillLearn.$inferInsert)[] = skills.unitLearns.map((l) => ({
    unitId: l.ownerId,
    position: l.position,
    level: l.level,
    skillId: l.skillId,
    rawLevel: l.rawLevel,
    playerOnly: l.playerOnly,
    enemyOnly: l.enemyOnly,
    bothSides: l.bothSides,
    hardOnly: l.hardOnly,
  }));
  await insertInChunks(unitLearnRows, (chunk) => db.insert(t.unitSkillLearn).values(chunk));

  const classLearnRows: (typeof t.classSkillLearn.$inferInsert)[] = skills.classLearns.map((l) => ({
    classId: l.ownerId,
    position: l.position,
    level: l.level,
    skillId: l.skillId,
    rawLevel: l.rawLevel,
    playerOnly: l.playerOnly,
    enemyOnly: l.enemyOnly,
    bothSides: l.bothSides,
    hardOnly: l.hardOnly,
  }));
  await insertInChunks(classLearnRows, (chunk) => db.insert(t.classSkillLearn).values(chunk));
}

/**
 * Event evidence, decoded effects, slot links and load blocks. Semantic
 * classifications are stored alongside source bytes; per-question derivations
 * (transitions, recruits, gains, joins) remain consumers of this evidence.
 */
async function insertEventTrace(db: ExtractDb, trace: EventTrace): Promise<void> {
  const scriptRows: (typeof t.eventScripts.$inferInsert)[] = trace.scripts.map((script) => ({
    id: script.id,
    address: script.address,
    stopReason: script.stopReason,
    instructionCount: script.instructionCount,
    unknownInstructionCount: script.unknownInstructionCount,
  }));
  await insertInChunks(scriptRows, (chunk) => db.insert(t.eventScripts).values(chunk));

  const instructionRows: (typeof t.eventInstructions.$inferInsert)[] = trace.instructions.map(
    (i) => ({
      scriptId: i.scriptId,
      seq: i.seq,
      address: i.address,
      bytes: i.bytes,
      pattern: i.pattern,
      args: i.args,
      opcode: i.opcode,
      category: i.category,
      targetMap: i.targetMap,
    }),
  );
  await insertInChunks(instructionRows, (chunk) => db.insert(t.eventInstructions).values(chunk));

  const blockRows: (typeof t.loadBlocks.$inferInsert)[] = trace.blocks.map((block) => ({
    id: block.id,
    address: block.address,
  }));
  await insertInChunks(blockRows, (chunk) => db.insert(t.loadBlocks).values(chunk));

  const loadRows: (typeof t.eventUnitLoads.$inferInsert)[] = [];
  const callRows: (typeof t.eventCalls.$inferInsert)[] = [];
  const goldRows: (typeof t.eventGold.$inferInsert)[] = [];
  const itemGrantRows: (typeof t.eventItemGrants.$inferInsert)[] = [];
  for (const i of trace.instructions) {
    for (const load of i.loads) {
      loadRows.push({
        scriptId: i.scriptId,
        seq: i.seq,
        position: load.position,
        kind: load.kind,
        blockId: load.blockId,
      });
    }
    for (const call of i.calls) {
      callRows.push({
        scriptId: i.scriptId,
        seq: i.seq,
        position: call.position,
        targetScriptId: call.scriptId,
      });
    }
    for (const gold of i.gold) {
      goldRows.push({ scriptId: i.scriptId, seq: i.seq, offset: gold.offset, delta: gold.delta });
    }
    for (const item of i.items) {
      itemGrantRows.push({
        scriptId: i.scriptId,
        seq: i.seq,
        position: item.position,
        itemId: item.itemId,
        unitId: item.unitId,
      });
    }
  }
  await insertInChunks(loadRows, (chunk) => db.insert(t.eventUnitLoads).values(chunk));
  await insertInChunks(callRows, (chunk) => db.insert(t.eventCalls).values(chunk));
  await insertInChunks(goldRows, (chunk) => db.insert(t.eventGold).values(chunk));
  await insertInChunks(itemGrantRows, (chunk) => db.insert(t.eventItemGrants).values(chunk));

  const slotRows: (typeof t.chapterEventSlots.$inferInsert)[] = trace.chapterSlots.map((slot) => ({
    mapIndex: slot.mapIndex,
    slotIndex: slot.slotIndex,
    slotKind: slot.slotKind,
    position: slot.position,
    scriptId: slot.scriptId,
    turnStart: slot.turn?.start ?? null,
    turnEnd: slot.turn?.end ?? null,
    turnPhase: slot.turn?.phase ?? null,
    condFlag: slot.condFlag,
  }));
  await insertInChunks(slotRows, (chunk) => db.insert(t.chapterEventSlots).values(chunk));

  const blockUnitRows: (typeof t.loadBlockUnits.$inferInsert)[] = trace.loadBlockUnits.map((u) => ({
    blockId: u.blockId,
    position: u.position,
    unitId: u.unitId,
    classId: u.classId,
    level: u.level,
    side: u.side,
    autolevel: u.autolevel === 1,
    x: u.x,
    y: u.y,
    items: u.items,
    ext: u.ext,
  }));
  await insertInChunks(blockUnitRows, (chunk) => db.insert(t.loadBlockUnits).values(chunk));
}

/** Persist simulator output without running game rules inside the transaction. */
async function insertUnitStats(db: ExtractDb, rows: readonly UnitStatRow[]): Promise<void> {
  const statRows: (typeof t.derivedUnitStats.$inferInsert)[] = rows.map((r) => ({
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
    statHp: r.stats.hp,
    statStr: r.stats.str,
    statSkl: r.stats.skl,
    statSpd: r.stats.spd,
    statDef: r.stats.def,
    statRes: r.stats.res,
    statLck: r.stats.lck,
    statCon: r.stats.con,
  }));
  await insertInChunks(statRows, (chunk) => db.insert(t.derivedUnitStats).values(chunk));
}

/** Condition slots, shops, map objects and the forced-sortie table. */
async function insertWorldData(db: ExtractDb, rom: ExtractionSnapshot): Promise<void> {
  const condRows: (typeof t.condSlots.$inferInsert)[] = rom.condSlots.map((slot) => ({
    idx: slot.index,
    flag: slot.flag,
    name: slot.name,
    kind: slot.kind,
  }));
  await insertInChunks(condRows, (chunk) => db.insert(t.condSlots).values(chunk));

  // Shops before objects: a map object links to its shop by id, and the link
  // key during parsing is the shop's list address.
  const shopIdByAddress = new Map<number, number>();
  const shopRows: (typeof t.shops.$inferInsert)[] = [];
  const shopItemRows: (typeof t.shopItems.$inferInsert)[] = [];
  if (rom.shopData !== null) {
    for (const [shopId, shop] of rom.shopData.shops.entries()) {
      shopIdByAddress.set(shop.addr, shopId);
      shopRows.push({ id: shopId, kind: shop.kind, mapIndex: shop.mapIndex });
      for (const [position, e] of shop.entries.entries()) {
        shopItemRows.push({
          shopId,
          position,
          itemId: e.itemId,
          uses: e.uses,
          effectiveUses: e.effectiveUses,
        });
      }
    }
  }
  await insertInChunks(shopRows, (chunk) => db.insert(t.shops).values(chunk));
  await insertInChunks(shopItemRows, (chunk) => db.insert(t.shopItems).values(chunk));

  const objectRows: (typeof t.mapObjects.$inferInsert)[] = [];
  for (const co of rom.chapterObjects) {
    for (const o of co.objects) {
      // A shop object whose address the shop scan never collected is a
      // reference inconsistency, not an absence. With foreign keys enforced
      // it fails the extract here instead of degrading to "not a shop" -
      // the same treatment every other dangling reference gets.
      let shopId: number | null = null;
      if (o.shopAddr !== 0) {
        const resolved = shopIdByAddress.get(o.shopAddr);
        if (resolved === undefined) {
          throw new Error(
            `map object (${o.x},${o.y}) of map ${co.chapterIndex} opens the shop at ` +
              `0x${o.shopAddr.toString(16)}, which the shop scan did not collect`,
          );
        }
        shopId = resolved;
      }
      objectRows.push({
        mapIndex: co.chapterIndex,
        type: o.type,
        kind: o.kind,
        flag: o.flag,
        objectType: o.objectType,
        objectTypeName: o.objectTypeName,
        x: o.x,
        y: o.y,
        itemId: o.itemId,
        gold: o.gold,
        isGoldChest: o.isGoldChest,
        shopId,
      });
    }
  }
  await insertInChunks(objectRows, (chunk) => db.insert(t.mapObjects).values(chunk));

  if (rom.forceSortie !== null) {
    const sortieRows: (typeof t.forceSortie.$inferInsert)[] = rom.forceSortie.records.map((r) => ({
      unitId: r.unitId,
      route: r.route,
      mapIndex: r.mapIndex,
    }));
    // Identical records are redundant, not an error.
    await insertInChunks(sortieRows, (chunk) =>
      db.insert(t.forceSortie).values(chunk).onConflictDoNothing(),
    );
  }
}

/**
 * Every inserter, in dependency order: the single declaration of write order,
 * asserted against the schema's foreign keys by {@link assertWritePipeline}
 * before each extract writes anything (see `pipeline.ts` for what is checked).
 *
 * A writer fills one domain - possibly several tables - and a table may be
 * filled by several writers (`meta` is written by the metadata, skill, and
 * unit writers). Grouping is deliberate: the invariants that span tables (the
 * shop id map in `insertWorldData`, the empty-slot count in `insertUnits`)
 * stay inside one inserter and one transaction.
 *
 * Adding a table means adding its inserter here in the right position; a
 * wrong position fails the extract at the assertion, not at the INSERT. Each
 * writer's `tables` array lists its own tables in the order that writer
 * inserts them, and the assertion checks the foreign keys at both levels, so a
 * reorder inside a writer is caught there too.
 */
export const TABLE_WRITERS: readonly TableWriter[] = [
  { name: "meta", tables: [t.meta], write: insertMeta },
  {
    name: "classes",
    tables: [t.classes, t.classAbilityFlags, t.classMovementCosts, t.classTerrainBonuses],
    write: insertClasses,
  },
  { name: "classBranches", tables: [t.classBranches], write: insertClassBranches },
  { name: "skills", tables: [t.skills, t.meta], write: insertSkillSystem },
  { name: "units", tables: [t.units, t.meta], write: insertUnits },
  {
    name: "skillAssignments",
    tables: [t.unitSkills, t.classSkills, t.unitSkillLearn, t.classSkillLearn],
    write: insertSkillAssignments,
  },
  { name: "affinities", tables: [t.affinities, t.supportBonuses], write: insertAffinities },
  {
    name: "supportLinks",
    tables: [t.supportEntries, t.supportPartners],
    write: insertSupportLinks,
  },
  {
    name: "items",
    tables: [t.items, t.itemEffectiveness, t.itemPromotions, t.terrains],
    write: insertItemsAndTerrain,
  },
  {
    name: "chapters",
    tables: [t.chapters, t.chapterPlacements, t.chapterPlacementSteps],
    write: insertChapters,
  },
  { name: "story", tables: [t.derivedPlayOrder], write: insertStory },
  {
    name: "eventTrace",
    // `insertEventTrace` inserts in exactly this order; the assertion in
    // `pipeline.ts` reads the array as that order and checks the foreign keys
    // against it, so a reorder there must be mirrored here.
    tables: [
      t.eventScripts,
      t.eventInstructions,
      t.loadBlocks,
      t.eventUnitLoads,
      t.eventCalls,
      t.eventGold,
      t.eventItemGrants,
      t.chapterEventSlots,
      t.loadBlockUnits,
    ],
    write: (db, rom) => insertEventTrace(db, rom.eventTrace),
  },
  {
    name: "unitStats",
    tables: [t.derivedUnitStats],
    write: (db, rom) => insertUnitStats(db, rom.unitStats),
  },
  {
    name: "worldData",
    tables: [t.condSlots, t.shops, t.shopItems, t.mapObjects, t.forceSortie],
    write: insertWorldData,
  },
];
