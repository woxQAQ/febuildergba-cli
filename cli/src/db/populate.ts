/**
 * Populate an extract database from a loaded ROM.
 *
 * Every lazy field of `LoadedRom` is read here - that is the point of
 * `extract`: pay the full parse once, persist the result, and let analysis
 * query the db instead of re-invoking the CLI. All inserts go through the
 * drizzle schema (`schema.ts`), so a column typo or a wrong value type is a
 * compile error here rather than a SQLite error halfway through an extract.
 *
 * Reads happen inside one transaction; a failure rolls the whole db back
 * rather than leaving a half-populated file that looks finished.
 */

import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import type { LoadedRom } from "../load.ts";
import { collectEnemyStats } from "../analysis/enemyStats.ts";
import { createSchemaSql } from "./ddl.ts";
import type { ExtractDb, OpenDb } from "./index.ts";
import * as t from "./schema.ts";

export interface PopulateResult {
  /** Row count per table, measured after the commit. */
  readonly tables: Readonly<Record<string, number>>;
  /** Enemy placement records dropped because their class id did not resolve. */
  readonly unresolvedEnemyClasses: number;
}

export async function populate(handle: OpenDb, rom: LoadedRom): Promise<PopulateResult> {
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
    const truncatedWalks = await insertEventScans(db, rom);
    const unresolvedEnemyClasses = await insertEnemySamples(db, rom);
    await db.insert(t.meta).values([
      { key: "scan.truncatedWalks", value: String(truncatedWalks) },
      { key: "enemy.unresolvedClasses", value: String(unresolvedEnemyClasses) },
    ]);
    sqlite.exec("COMMIT");

    // Row counts measured, not tallied: the number reported is the number
    // that actually landed.
    const tables: Record<string, number> = {};
    for (const table of t.TABLES) {
      const row = await db.select({ n: sql<number>`count(*)` }).from(table).get();
      tables[getTableConfig(table).name] = row?.n ?? 0;
    }
    return { tables, unresolvedEnemyClasses };
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

async function insertMeta(db: ExtractDb, rom: LoadedRom): Promise<void> {
  await db.insert(t.meta).values([
    { key: "rom.path", value: rom.path },
    { key: "rom.sizeBytes", value: String(rom.rom.length) },
    { key: "rom.gameCode", value: rom.identity.gameCode },
    { key: "rom.title", value: rom.identity.title },
    { key: "rom.version", value: rom.layout.version },
    { key: "rom.displayName", value: rom.layout.displayName },
    { key: "rom.isMultibyte", value: String(rom.layout.text.isMultibyte) },
    { key: "rom.notes", value: JSON.stringify(rom.identity.notes) },
    { key: "config.dir", value: rom.configDir ?? "" },
    { key: "config.language", value: rom.configLanguage ?? "en" },
    { key: "playOrder.mainPath", value: JSON.stringify(rom.playOrder.mainPath) },
    { key: "playOrder.branches", value: JSON.stringify(rom.playOrder.branches) },
    { key: "playOrder.closedLoop", value: JSON.stringify(rom.playOrder.closedLoop) },
  ]);
}

/** Empty slots (no name, class or level) are skipped; the count lands in meta. */
async function insertUnits(db: ExtractDb, rom: LoadedRom): Promise<void> {
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

async function insertClasses(db: ExtractDb, rom: LoadedRom): Promise<void> {
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

  for (const [classId, role] of rom.classRoles) {
    await db.insert(t.derivedClassRoles).values({
      classId,
      mobility: role.mobility,
      mobilitySource: role.mobilitySource,
    });
  }
}

async function insertSupports(db: ExtractDb, rom: LoadedRom): Promise<void> {
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

async function insertItemsAndTerrain(db: ExtractDb, rom: LoadedRom): Promise<void> {
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

async function insertChapters(db: ExtractDb, rom: LoadedRom): Promise<void> {
  for (const c of rom.chapters) {
    await db.insert(t.chapters).values({
      mapIndex: c.index,
      chapterNumber: c.chapterNumber,
      titleTextId: c.titleTextId,
      title: c.title,
      weatherId: c.weatherId,
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

async function insertStory(db: ExtractDb, rom: LoadedRom): Promise<void> {
  for (const e of rom.mapTransitions) {
    for (const tr of e.transitions) {
      await db.insert(t.derivedChapterTransitions).values({
        mapIndex: e.mapIndex,
        targetMap: tr.targetMap,
        opcode: tr.opcode,
        callDepth: tr.callDepth,
      });
    }
  }
  for (const step of rom.playOrder.steps) {
    await db.insert(t.derivedPlayOrder).values({
      mapIndex: step.mapIndex,
      position: step.order,
      role: step.role,
      playable: step.playable,
    });
  }

  for (const [kind, map] of [
    ["join", rom.joins.joins],
    ["appearance", rom.joins.appearances],
  ] as const) {
    for (const [unitId, ev] of map) {
      await db.insert(t.derivedUnitJoins).values({
        unitId,
        kind,
        mapIndex: ev.chapterIndex,
        storyOrder: ev.storyOrder,
        source: ev.source,
        classOverridden: ev.classOverridden,
        placedClassId: ev.placedClassId,
      });
    }
  }
}

/** Returns the total truncated walk count, for meta. */
async function insertEventScans(db: ExtractDb, rom: LoadedRom): Promise<number> {
  for (const slot of rom.condSlots) {
    await db
      .insert(t.condSlots)
      .values({ idx: slot.index, flag: slot.flag, name: slot.name, kind: slot.kind });
  }

  let truncatedWalks = 0;
  for (const scan of rom.chapterScans) {
    truncatedWalks += scan.truncatedWalks;
    for (const [site, r] of scan.recruits.entries()) {
      await db.insert(t.derivedChapterRecruits).values({
        mapIndex: scan.chapterIndex,
        site,
        kind: r.kind,
      });
      for (const [position, u] of r.units.entries()) {
        await db.insert(t.derivedChapterRecruitUnits).values({
          mapIndex: scan.chapterIndex,
          site,
          position,
          unitId: u.unitId,
          classId: u.classId,
          level: u.level,
          side: u.side,
          x: u.prePlacementCoord.x,
          y: u.prePlacementCoord.y,
        });
      }
    }
    for (const g of scan.gold) {
      await db.insert(t.derivedChapterGold).values({ mapIndex: scan.chapterIndex, delta: g.delta });
    }
    for (const g of scan.itemsGiven) {
      await db.insert(t.derivedChapterItemGives).values({
        mapIndex: scan.chapterIndex,
        itemId: g.itemId,
        unitId: g.unitId,
      });
    }
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

  return truncatedWalks;
}

/**
 * Both autolevel modes, so normal-vs-hard is a WHERE clause, not a re-run.
 * Returns the unresolved-class count for meta.
 */
async function insertEnemySamples(db: ExtractDb, rom: LoadedRom): Promise<number> {
  let unresolved = 0;
  for (const mode of ["normal", "hard"] as const) {
    const { samples, unresolvedClass } = collectEnemyStats({
      rom: rom.rom,
      layout: rom.layout,
      eventScripts: rom.eventScripts,
      chapters: rom.chapters,
      condSlots: rom.condSlots,
      classes: rom.classes,
      units: rom.units,
      items: rom.items,
      hard: mode === "hard",
    });
    unresolved = unresolvedClass;
    for (const s of samples) {
      await db.insert(t.derivedEnemySamples).values({
        mode,
        mapIndex: s.mapIndex,
        chapterNumber: s.chapterNumber,
        unitId: s.unitId,
        classId: s.classId,
        level: s.level,
        grow: s.grow === 1,
        routine: s.routine,
        promoted: s.promoted,
        classBaseSpd: s.classBaseSpd,
        unitSpdDelta: s.unitSpdDelta,
        spdLo: s.spd.lo,
        spdHi: s.spd.hi,
        spdMean: s.spd.mean,
        con: s.con,
        weight: s.weight,
        weightFirst: s.weightFirst,
        asLo: s.as.lo,
        asHi: s.as.hi,
        asMean: s.as.mean,
      });
    }
  }
  return unresolved;
}
