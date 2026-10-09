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
    const emptySlots = await insertUnits(db, rom);
    await db
      .insert(t.meta)
      .values({ key: "units.emptySlots", value: String(emptySlots) });
    await insertClasses(db, rom);
    await insertSupports(db, rom);
    await insertItemsAndTerrain(db, rom);
    await insertChapters(db, rom);
    await insertStory(db, rom);
    await insertEventScans(db, rom);
    const unresolvedEnemyClasses = await insertEnemySamples(db, rom);
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
  const entries: (typeof t.meta.$inferInsert)[] = [
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
    {
      key: "tables",
      value: JSON.stringify({
        unit: {
          slot: rom.unitTable.slotOffset,
          address: rom.unitTable.tableOffset,
          recordSize: rom.unitTable.recordSize,
          declaredCount: rom.unitTable.maxCount,
        },
        class: {
          slot: rom.classTable.slotOffset,
          address: rom.classTable.tableOffset,
          recordSize: rom.classTable.recordSize,
        },
        text: {
          huffmanTreeBase: rom.text.treeBase,
          huffmanDataBase: rom.text.treeDataBase,
          textTableBase: rom.text.textBase,
        },
      }),
    },
  ];
  for (const entry of entries) await db.insert(t.meta).values(entry);
}

/**
 * Empty slots (no name, class or level) are skipped: they carry no data and
 * their id 0 is not unique. Returns how many were skipped, for `meta`.
 */
async function insertUnits(db: ExtractDb, rom: LoadedRom): Promise<number> {
  let skipped = 0;
  for (const u of rom.units) {
    if (u.isEmpty) {
      skipped++;
      continue;
    }
    await db.insert(t.units).values({
      id: u.id,
      address: u.address,
      name: u.name,
      nameRaw: u.nameRaw,
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
      supportPointer: u.supportPointer,
      supportAddress: u.supportAddress,
      hasSupportData: u.hasSupportData,
    });
  }
  return skipped;
}

async function insertClasses(db: ExtractDb, rom: LoadedRom): Promise<void> {
  for (const c of rom.classes) {
    await db.insert(t.classes).values({
      id: c.id,
      address: c.address,
      name: c.name,
      nameTextId: c.nameTextId,
      description: c.description,
      promotesToClassId: c.promotesToClassId,
      sortOrder: c.sortOrder,
      movementRange: c.movementRange,
      movementSpeed: c.movementSpeed,
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
    for (const [terrainId, cost] of c.movementCosts.entries()) {
      await db.insert(t.classMovementCosts).values({ classId: c.id, terrainId, cost });
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
    await db.insert(t.classRoles).values({
      classId,
      mobility: role.mobility,
      mobilitySource: role.mobilitySource,
      weapons: role.weapons,
      hasStaff: role.hasStaff,
      isMagic: role.isMagic,
    });
  }
}

async function insertSupports(db: ExtractDb, rom: LoadedRom): Promise<void> {
  for (const [id, name] of rom.affinityNames) {
    await db.insert(t.affinities).values({ id, name });
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
      address: e.address,
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
  for (const e of rom.supportGraph) {
    await db
      .insert(t.supportEdges)
      .values({ a: e.a, b: e.b, initial: e.initial, growth: e.growth });
  }
  await db
    .insert(t.meta)
    .values({ key: "supports.missingPointers", value: JSON.stringify(rom.supports.missing) });
}

async function insertItemsAndTerrain(db: ExtractDb, rom: LoadedRom): Promise<void> {
  for (const i of rom.items) {
    await db.insert(t.items).values({
      id: i.id,
      address: i.addr,
      name: i.name,
      nameRaw: i.nameRaw,
      nameTextId: i.nameTextId,
      descTextId: i.descTextId,
      useDescTextId: i.useDescTextId,
      nameKind: i.nameKind,
      nameUnknownCodes: i.nameUnknownCodes,
      description: i.desc,
      type: i.type,
      typeName: i.typeName,
      attributes: i.attributes,
      statBonusPointer: i.statBonusPointer,
      effectivenessPointer: i.effectivenessPointer,
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
  }

  for (const terrain of rom.terrainNames.names) {
    await db.insert(t.terrains).values({
      id: terrain.id,
      name: terrain.name,
      textId: terrain.textId,
      nameAddress: terrain.nameAddress,
      decoded: terrain.decoded,
      raw: terrain.raw,
    });
  }
}

async function insertChapters(db: ExtractDb, rom: LoadedRom): Promise<void> {
  for (const c of rom.chapters) {
    await db.insert(t.chapters).values({
      mapIndex: c.index,
      mapSettingAddr: c.mapSettingAddr,
      chapterNumber: c.chapterNumber,
      chapterNumberRaw: c.chapterNumberRaw,
      titleTextId: c.titleTextId,
      title: c.title,
      eventPlist: c.eventPlist,
      condTableAddr: c.condTableAddr,
      condPointers: c.condPointers,
      playerPlacementAddr: c.playerPlacementAddr,
      hardPlacementAddr: c.hardPlacementAddr,
      startEventAddr: c.startEventAddr,
      endEventAddr: c.endEventAddr,
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
          address: p.addr,
          unitId: p.unitId,
          classId: p.classId,
          commander: p.commander,
          level: p.level,
          unitGrow: p.unitGrow,
          assign: p.assign,
          side: p.side,
          autolevel: p.autolevel === 1,
          x: p.prePlacementCoord.x,
          y: p.prePlacementCoord.y,
          ext: p.prePlacementCoord.ext,
          positionRaw: p.position,
          postPlacementCount: p.postPlacementCount,
          postPlacementAddr: p.postPlacementAddr,
          items: p.items,
        });
      }
    }
  }
}

async function insertStory(db: ExtractDb, rom: LoadedRom): Promise<void> {
  for (const e of rom.mapTransitions) {
    await db.insert(t.chapterEndEvents).values({
      mapIndex: e.mapIndex,
      endEventAddress: e.endEventAddress,
      instructionsDecoded: e.instructionsDecoded,
      stopReason: e.stopReason,
    });
    for (const tr of e.transitions) {
      await db.insert(t.chapterTransitions).values({
        mapIndex: e.mapIndex,
        targetMap: tr.targetMap,
        opcode: tr.opcode,
        scriptAddress: tr.scriptAddress,
        callDepth: tr.callDepth,
      });
    }
  }
  for (const step of rom.playOrder.steps) {
    await db.insert(t.playOrder).values({
      mapIndex: step.mapIndex,
      position: step.order,
      role: step.role,
      playable: step.playable,
    });
  }
  await db.insert(t.meta).values([
    { key: "playOrder.mainPath", value: JSON.stringify(rom.playOrder.mainPath) },
    { key: "playOrder.branches", value: JSON.stringify(rom.playOrder.branches) },
    { key: "playOrder.closedLoop", value: JSON.stringify(rom.playOrder.closedLoop) },
  ]);

  for (const [kind, map] of [
    ["join", rom.joins.joins],
    ["appearance", rom.joins.appearances],
  ] as const) {
    for (const [unitId, ev] of map) {
      await db.insert(t.unitJoins).values({
        unitId,
        kind,
        mapIndex: ev.chapterIndex,
        storyOrder: ev.storyOrder,
        source: ev.source,
        evidenceAddr: ev.evidenceAddr,
        classOverridden: ev.classOverridden,
        placedClassId: ev.placedClassId,
      });
    }
  }
}

async function insertEventScans(db: ExtractDb, rom: LoadedRom): Promise<void> {
  for (const slot of rom.condSlots) {
    await db
      .insert(t.condSlots)
      .values({ idx: slot.index, flag: slot.flag, name: slot.name, kind: slot.kind });
  }
  for (const scan of rom.chapterScans) {
    await db
      .insert(t.chapterScanStats)
      .values({ mapIndex: scan.chapterIndex, truncatedWalks: scan.truncatedWalks });
    for (const r of scan.recruits) {
      await db.insert(t.chapterRecruits).values({
        mapIndex: scan.chapterIndex,
        address: r.addr,
        slotIndex: r.slotIndex,
        slotKind: r.slotKind,
        instruction: r.instruction,
        kind: r.kind,
        blockAddr: r.blockAddr,
        unitIds: r.units.map((u) => u.unitId),
      });
    }
    for (const g of scan.gold) {
      await db.insert(t.chapterGold).values({
        mapIndex: scan.chapterIndex,
        address: g.addr,
        delta: g.delta,
        instruction: g.instruction,
      });
    }
    for (const g of scan.itemsGiven) {
      await db.insert(t.chapterItemGives).values({
        mapIndex: scan.chapterIndex,
        address: g.addr,
        itemId: g.itemId,
        unitId: g.unitId,
        instruction: g.instruction,
      });
    }
  }

  for (const co of rom.chapterObjects) {
    for (const o of co.objects) {
      await db.insert(t.mapObjects).values({
        mapIndex: co.chapterIndex,
        address: o.addr,
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
        eventAddr: o.eventAddr,
        shopAddr: o.shopAddr,
      });
    }
  }

  if (rom.shopData !== null) {
    for (const [shopId, shop] of rom.shopData.shops.entries()) {
      await db.insert(t.shops).values({
        id: shopId,
        kind: shop.kind,
        label: shop.label,
        address: shop.addr,
        mapIndex: shop.mapIndex,
        chapterNumber: shop.chapterNumber,
        chapterTitle: shop.chapterTitle,
      });
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

  if (rom.forceSortie !== null) {
    for (const r of rom.forceSortie.records) {
      await db.insert(t.forceSortie).values({
        idx: r.index,
        address: r.addr,
        unitId: r.unitId,
        route: r.route,
        mapIndex: r.mapIndex,
      });
    }
  }
}

/**
 * Both autolevel modes, so normal-vs-hard is a WHERE clause, not a re-run.
 * Returns the unresolved-class count for the extract warning.
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
      await db.insert(t.enemySamples).values({
        mode,
        mapIndex: s.mapIndex,
        chapterNumber: s.chapterNumber,
        address: s.addr,
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
