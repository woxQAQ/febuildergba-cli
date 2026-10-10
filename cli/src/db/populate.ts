/**
 * Populate an extract database from a parsed ROM - the persistence half of the
 * extract. All inserts go through the drizzle schema (`schema.ts`), so a column
 * typo or wrong value type is a compile error, not a SQLite error mid-extract.
 * Reads run in one transaction; a failure rolls the whole db back.
 */

import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import type { ParsedRom } from "../load.ts";
import { extractEventTrace } from "../tables/eventTrace.ts";
import type { EventTrace } from "../tables/eventTrace.ts";
import { buildUnitStats } from "../tables/unitStats.ts";
import { createSchemaSql } from "./ddl.ts";
import type { ExtractDb, OpenDb } from "./index.ts";
import * as t from "./schema.ts";

export interface PopulateResult {
  /** Row count per table, measured after the commit. */
  readonly tables: Readonly<Record<string, number>>;
}

export async function populate(handle: OpenDb, rom: ParsedRom): Promise<PopulateResult> {
  const { db, sqlite } = handle;
  for (const statement of createSchemaSql(t.TABLES)) sqlite.exec(statement);

  sqlite.exec("BEGIN");
  try {
    await insertMeta(db, rom);
    await insertUnits(db, rom);
    await insertClasses(db, rom);
    await insertSupports(db, rom);
    await insertItemsAndTerrain(db, rom);
    await insertChapters(db, rom);
    await insertStory(db, rom);
    await insertSkills(db, rom);
    // The trace is walked once and consumed twice: it is the raw event layer,
    // and it is also the only route to "which units appear in which chapter",
    // which `derived_unit_stats` needs.
    const trace = extractEventTrace(
      rom.rom,
      rom.layout,
      rom.chapters,
      rom.condSlots,
      rom.eventScripts,
    );
    await insertEventTrace(db, rom, trace);
    await insertUnitStats(db, rom, trace);
    await insertWorldData(db, rom);
    sqlite.exec("COMMIT");

    // Row counts measured, not tallied: the number reported is the number
    // that actually landed.
    const tables: Record<string, number> = {};
    for (const table of t.TABLES) {
      const row = await db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .get();
      tables[getTableConfig(table).name] = row?.n ?? 0;
    }
    return { tables };
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

async function insertMeta(db: ExtractDb, rom: ParsedRom): Promise<void> {
  await db.insert(t.meta).values([
    { key: "rom.path", value: rom.path },
    { key: "rom.sizeBytes", value: String(rom.rom.length) },
    { key: "rom.gameCode", value: rom.identity.gameCode },
    { key: "rom.title", value: rom.identity.title },
    { key: "rom.version", value: rom.layout.version },
    { key: "rom.displayName", value: rom.layout.displayName },
    { key: "rom.isMultibyte", value: String(rom.layout.text.isMultibyte) },
    // Which skill-system patch family the ROM carries, or "none". Detection
    // only - it gates how the rest of the ROM should be interpreted (a
    // patched ROM relocates other tables), it is not skill data.
    { key: "rom.skillSystem", value: rom.identity.skillSystem },
    { key: "rom.notes", value: JSON.stringify(rom.identity.notes) },
    { key: "config.dir", value: rom.configDir ?? "" },
    { key: "config.language", value: rom.configLanguage ?? "en" },
    // `mainPath` is not stored: it is `derived_play_order` filtered to
    // role='main'. `branches` and `closedLoop` are not expressible from the
    // table, so they stay here as run-level facts.
    { key: "playOrder.branches", value: JSON.stringify(rom.playOrder.branches) },
    { key: "playOrder.closedLoop", value: JSON.stringify(rom.playOrder.closedLoop) },
  ]);
}

/** Empty slots (no name, class or level) are skipped; the count lands in meta. */
async function insertUnits(db: ExtractDb, rom: ParsedRom): Promise<void> {
  let skipped = 0;
  for (const u of rom.units) {
    if (u.isEmpty) {
      skipped++;
      continue;
    }
    await db.insert(t.units).values({
      id: u.id,
      name: u.name,
      nameTextId: u.nameTextId,
      description: u.description,
      descTextId: u.descriptionTextId,
      classId: u.classId,
      isPromotedClass: u.isPromotedClass,
      mapFaceId: u.mapFaceId,
      portraitId: u.portraitId,
      affinityId: u.attribute,
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
  await db.insert(t.meta).values({ key: "units.emptySlots", value: String(skipped) });
}

async function insertClasses(db: ExtractDb, rom: ParsedRom): Promise<void> {
  for (const c of rom.classes) {
    await db.insert(t.classes).values({
      id: c.id,
      name: c.name,
      nameTextId: c.nameTextId,
      description: c.description,
      promotesToClassId: c.promotesToClassId,
      sortOrder: c.sortOrder,
      movementRange: c.movementRange,
      movementSpeed: c.movementSpeed,
      experienceBonus: c.experienceBonus,
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
      await db.insert(t.classAbilityFlags).values({ classId: c.id, flag });
    }
    for (const [variant, costs] of [
      ["normal", c.movementCosts],
      ["rain", c.movementCostsRain],
      ["snow", c.movementCostsSnow],
    ] as const) {
      for (const [terrainId, cost] of costs.entries()) {
        await db.insert(t.classMovementCosts).values({ classId: c.id, variant, terrainId, cost });
      }
    }
    if (c.terrainBonuses !== null) {
      for (const [terrainId, avoid] of c.terrainBonuses.avoid.entries()) {
        await db.insert(t.classTerrainBonuses).values({
          classId: c.id,
          terrainId,
          avoid,
          def: c.terrainBonuses.def[terrainId] ?? 0,
          res: c.terrainBonuses.res[terrainId] ?? 0,
        });
      }
    }
  }
}

async function insertSupports(db: ExtractDb, rom: ParsedRom): Promise<void> {
  // Every referenced affinity id gets a row, named or not: a unit carrying
  // an unnamed hack affinity is data, not an absence of data.
  const affinityIds = new Set<number>(rom.affinityNames.keys());
  for (const b of rom.supportBonuses) affinityIds.add(b.affinity);
  for (const u of rom.units) {
    if (u.attribute !== 0) affinityIds.add(u.attribute);
  }
  for (const id of [...affinityIds].sort((a, b) => a - b)) {
    await db.insert(t.affinities).values({ id, name: rom.affinityNames.get(id) ?? null });
  }

  for (const b of rom.supportBonuses) {
    await db.insert(t.supportBonuses).values({
      affinityId: b.affinity,
      atkHalf: b.bonuses.atk,
      defHalf: b.bonuses.def,
      hitHalf: b.bonuses.hit,
      avoidHalf: b.bonuses.avoid,
      critHalf: b.bonuses.crit,
      critAvoidHalf: b.bonuses.critAvoid,
    });
  }
  for (const e of rom.supports.entries) {
    await db.insert(t.supportEntries).values({
      unitId: e.unitId,
      declaredCount: e.declaredCount,
      actualCount: e.actualCount,
    });
    for (const p of e.partners) {
      await db.insert(t.supportPartners).values({
        unitId: e.unitId,
        partnerId: p.unitId,
        initial: p.initial,
        growth: p.growth,
      });
    }
  }
  // support_edges is a VIEW over support_partners now - nothing to insert.
}

async function insertItemsAndTerrain(db: ExtractDb, rom: ParsedRom): Promise<void> {
  for (const i of rom.items) {
    await db.insert(t.items).values({
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
      await db.insert(t.itemEffectiveness).values({ itemId: i.id, classId });
    }
    /**
     * The class list is the same for every item sharing an effect code; rows
     * are per item so a query can ask "can this item promote this class"
     * without first mapping item -> code.
     */
    for (const classId of new Set(i.promotionClasses ?? [])) {
      await db
        .insert(t.itemPromotions)
        .values({ itemId: i.id, classId, effectCode: i.staffEffect });
    }
  }

  for (const terrain of rom.terrainNames.names) {
    await db.insert(t.terrains).values({
      id: terrain.id,
      name: terrain.name,
      textId: terrain.textId,
      decoded: terrain.decoded,
    });
  }
}

async function insertChapters(db: ExtractDb, rom: ParsedRom): Promise<void> {
  for (const c of rom.chapters) {
    await db.insert(t.chapters).values({
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
        await db.insert(t.chapterPlacements).values({
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
          await db.insert(t.chapterPlacementSteps).values({
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
}

/**
 * The play order is the one story-path artifact that stays materialized:
 * branch splicing ("a side chapter is played between its branch parent and
 * the next main chapter") is a custom ordering SQL cannot express. The
 * transitions it reads are the `chapter_transitions` view over the raw
 * event layer.
 */
async function insertStory(db: ExtractDb, rom: ParsedRom): Promise<void> {
  for (const step of rom.playOrder.steps) {
    await db.insert(t.derivedPlayOrder).values({
      mapIndex: step.mapIndex,
      position: step.order,
      role: step.role,
      playable: step.playable,
    });
  }
}

/**
 * Skill tables. Empty for a ROM without the patch, which is why the
 * `skills.classSkillExtends` meta flag is written either way - it is the only
 * thing that distinguishes "no skill system" from "a skill system whose learn
 * lists carry no difficulty bits".
 */
async function insertSkills(db: ExtractDb, rom: ParsedRom): Promise<void> {
  const skills = rom.skills;
  if (skills === null) {
    await db.insert(t.meta).values({ key: "skills.classSkillExtends", value: "false" });
    return;
  }
  await db.insert(t.meta).values({
    key: "skills.classSkillExtends",
    value: String(skills.classSkillExtends),
  });

  for (const s of skills.skills) {
    await db.insert(t.skills).values({
      id: s.id,
      nameTextId: s.nameTextId,
      name: s.name,
      description: s.description,
      text: s.text,
    });
  }
  for (const a of skills.unitSkills) {
    await db.insert(t.unitSkills).values({ unitId: a.ownerId, skillId: a.skillId });
  }
  for (const a of skills.classSkills) {
    await db.insert(t.classSkills).values({ classId: a.ownerId, skillId: a.skillId });
  }
  for (const l of skills.unitLearns) {
    await db.insert(t.unitSkillLearn).values({
      unitId: l.ownerId,
      position: l.position,
      level: l.level,
      skillId: l.skillId,
      rawLevel: l.rawLevel,
      playerOnly: l.playerOnly,
      enemyOnly: l.enemyOnly,
      bothSides: l.bothSides,
      hardOnly: l.hardOnly,
    });
  }
  for (const l of skills.classLearns) {
    await db.insert(t.classSkillLearn).values({
      classId: l.ownerId,
      position: l.position,
      level: l.level,
      skillId: l.skillId,
      rawLevel: l.rawLevel,
      playerOnly: l.playerOnly,
      enemyOnly: l.enemyOnly,
      bothSides: l.bothSides,
      hardOnly: l.hardOnly,
    });
  }
}

/**
 * The raw event layer: scripts, instructions, slot links and load blocks.
 * Walk-based derivations (transitions, recruits, gold, joins) are views over
 * these tables - nothing derived is inserted here.
 */
async function insertEventTrace(db: ExtractDb, rom: ParsedRom, trace: EventTrace): Promise<void> {
  for (const script of trace.scripts) {
    await db.insert(t.eventScripts).values({
      id: script.id,
      stopReason: script.stopReason,
      instructionCount: script.instructionCount,
    });
  }
  for (const i of trace.instructions) {
    await db.insert(t.eventInstructions).values({
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
    });
  }
  for (const slot of trace.chapterSlots) {
    await db.insert(t.chapterEventSlots).values({
      mapIndex: slot.mapIndex,
      slotIndex: slot.slotIndex,
      slotKind: slot.slotKind,
      position: slot.position,
      scriptId: slot.scriptId,
      turnStart: slot.turn?.start ?? null,
      turnEnd: slot.turn?.end ?? null,
      turnPhase: slot.turn?.phase ?? null,
      condFlag: slot.condFlag,
    });
  }
  for (let id = 0; id < trace.loadBlockCount; id++) {
    await db.insert(t.loadBlocks).values({ id });
  }
  for (const u of trace.loadBlockUnits) {
    await db.insert(t.loadBlockUnits).values({
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
    });
  }
}

/**
 * The stats each unit enters each chapter with, at each difficulty.
 *
 * Pure arithmetic over tables that are already parsed, so it lives beside the
 * insert rather than in the reader - but see `tables/unitStats.ts` for why it
 * is materialized instead of left to the query layer.
 */
async function insertUnitStats(db: ExtractDb, rom: ParsedRom, trace: EventTrace): Promise<void> {
  const rows = buildUnitStats({
    units: rom.units,
    classes: rom.classes,
    chapters: rom.chapters,
    trace,
  });
  for (const r of rows) {
    await db.insert(t.derivedUnitStats).values({
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
    });
  }
}

/** Condition slots, shops, map objects and the forced-sortie table. */
async function insertWorldData(db: ExtractDb, rom: ParsedRom): Promise<void> {
  for (const slot of rom.condSlots) {
    await db
      .insert(t.condSlots)
      .values({ idx: slot.index, flag: slot.flag, name: slot.name, kind: slot.kind });
  }

  // Shops before objects: a map object links to its shop by id, and the link
  // key during parsing is the shop's list address.
  const shopIdByAddress = new Map<number, number>();
  if (rom.shopData !== null) {
    for (const [shopId, shop] of rom.shopData.shops.entries()) {
      shopIdByAddress.set(shop.addr, shopId);
      await db.insert(t.shops).values({ id: shopId, kind: shop.kind, mapIndex: shop.mapIndex });
      for (const [position, e] of shop.entries.entries()) {
        await db.insert(t.shopItems).values({
          shopId,
          position,
          itemId: e.itemId,
          uses: e.uses,
          effectiveUses: e.effectiveUses,
        });
      }
    }
  }

  for (const co of rom.chapterObjects) {
    for (const o of co.objects) {
      await db.insert(t.mapObjects).values({
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
        shopId: o.shopAddr === 0 ? null : (shopIdByAddress.get(o.shopAddr) ?? null),
      });
    }
  }

  if (rom.forceSortie !== null) {
    for (const r of rom.forceSortie.records) {
      await db
        .insert(t.forceSortie)
        .values({ unitId: r.unitId, route: r.route, mapIndex: r.mapIndex })
        // Identical records are redundant, not an error.
        .onConflictDoNothing();
    }
  }
}
