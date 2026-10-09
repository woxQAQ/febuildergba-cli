/**
 * Populate an extract database from a loaded ROM.
 *
 * Every lazy field of `LoadedRom` is read here - that is the point of
 * `extract`: pay the full parse once, persist the result, and let analysis
 * query the db instead of re-invoking the CLI. Reads happen inside one
 * transaction; a failure rolls the whole db back rather than leaving a
 * half-populated file that looks like a finished extract.
 */

import type { DatabaseSync } from "node:sqlite";

import type { LoadedRom } from "../load.ts";
import { collectEnemyStats } from "../analysis/enemyStats.ts";
import { SCHEMA } from "./schema.ts";

type Value = string | number | null;

/** SQLite has no boolean; 0/1 columns by convention (see schema.ts). */
const bit = (v: boolean): number => (v ? 1 : 0);
const json = JSON.stringify;

/**
 * A prepared insert that counts its own rows, for the extract summary.
 *
 * Takes the column count rather than a hand-written `VALUES (?, ...)` tail -
 * a miscounted placeholder list is exactly the kind of mismatch SQLite only
 * reports at run time, halfway through an extract.
 */
function table(db: DatabaseSync, name: string, columns: number) {
  const placeholders = new Array(columns).fill("?").join(", ");
  const stmt = db.prepare(`INSERT INTO ${name} VALUES (${placeholders})`);
  let count = 0;
  return {
    add(...values: Value[]): void {
      if (values.length !== columns) {
        throw new Error(`${name}: expected ${columns} values, got ${values.length}`);
      }
      stmt.run(...values);
      count++;
    },
    count(): number {
      return count;
    },
  };
}

export interface PopulateResult {
  /** Row count per table, in insertion order. */
  readonly tables: Readonly<Record<string, number>>;
  /** Enemy placement records dropped because their class id did not resolve. */
  readonly unresolvedEnemyClasses: number;
}

export function populate(db: DatabaseSync, rom: LoadedRom): PopulateResult {
  db.exec(SCHEMA);

  const meta = table(db, "meta", 2);
  const units = table(db, "units", 44);
  const classes = table(db, "classes", 51);
  const abilityFlags = table(db, "class_ability_flags", 2);
  const moveCosts = table(db, "class_movement_costs", 3);
  const terrainBonuses = table(db, "class_terrain_bonuses", 5);
  const classRoles = table(db, "class_roles", 6);
  const terrains = table(db, "terrains", 6);
  const affinities = table(db, "affinities", 2);
  const supportBonuses = table(db, "support_bonuses", 7);
  const supportEntries = table(db, "support_entries", 4);
  const supportPartners = table(db, "support_partners", 4);
  const supportEdges = table(db, "support_edges", 4);
  const items = table(db, "items", 29);
  const shops = table(db, "shops", 7);
  const shopItems = table(db, "shop_items", 5);
  const chapters = table(db, "chapters", 15);
  const placements = table(db, "chapter_placements", 19);
  const endEvents = table(db, "chapter_end_events", 4);
  const transitions = table(db, "chapter_transitions", 5);
  const playOrder = table(db, "play_order", 4);
  const unitJoins = table(db, "unit_joins", 8);
  const mapObjects = table(db, "map_objects", 14);
  const forceSortie = table(db, "force_sortie", 5);
  const condSlots = table(db, "cond_slots", 4);
  const recruits = table(db, "chapter_recruits", 8);
  const gold = table(db, "chapter_gold", 4);
  const itemGives = table(db, "chapter_item_gives", 5);
  const scanStats = table(db, "chapter_scan_stats", 2);
  const enemySamples = table(db, "enemy_samples", 21);

  db.exec("BEGIN");
  try {
    // ------------------------------------------------------------ provenance
    meta.add("rom.path", rom.path);
    meta.add("rom.sizeBytes", String(rom.rom.length));
    meta.add("rom.gameCode", rom.identity.gameCode);
    meta.add("rom.title", rom.identity.title);
    meta.add("rom.version", rom.layout.version);
    meta.add("rom.displayName", rom.layout.displayName);
    meta.add("rom.isMultibyte", String(rom.layout.text.isMultibyte));
    meta.add("rom.notes", json(rom.identity.notes));
    meta.add("config.dir", rom.configDir ?? "");
    meta.add("config.language", rom.configLanguage ?? "en");
    meta.add(
      "tables",
      json({
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
    );

    // ----------------------------------------------------------------- units
    for (const u of rom.units) {
      units.add(
        u.id,
        u.index,
        u.address,
        u.name,
        u.nameRaw,
        u.nameTextId,
        u.description,
        u.descriptionTextId,
        u.classId,
        bit(u.isPromotedClass),
        u.mapFaceId,
        u.portraitId,
        u.attribute,
        u.sortOrder,
        u.level,
        u.stats.hp,
        u.stats.str,
        u.stats.skl,
        u.stats.spd,
        u.stats.def,
        u.stats.res,
        u.stats.lck,
        u.stats.con,
        u.growths.hp,
        u.growths.str,
        u.growths.skl,
        u.growths.spd,
        u.growths.def,
        u.growths.res,
        u.growths.lck,
        u.growthTotal,
        u.weaponLevels.sword,
        u.weaponLevels.lance,
        u.weaponLevels.axe,
        u.weaponLevels.bow,
        u.weaponLevels.staff,
        u.weaponLevels.anima,
        u.weaponLevels.light,
        u.weaponLevels.dark,
        json(u.abilityFlags),
        u.supportPointer,
        u.supportAddress,
        bit(u.hasSupportData),
        bit(u.isEmpty),
      );
    }

    // --------------------------------------------------------------- classes
    for (const c of rom.classes) {
      classes.add(
        c.id,
        c.index,
        c.address,
        c.name,
        c.nameTextId,
        c.description,
        c.promotesToClassId,
        c.sortOrder,
        c.movementRange,
        c.movementSpeed,
        c.bases.hp,
        c.bases.str,
        c.bases.skl,
        c.bases.spd,
        c.bases.def,
        c.bases.res,
        c.bases.con,
        c.caps.hp,
        c.caps.str,
        c.caps.skl,
        c.caps.spd,
        c.caps.def,
        c.caps.res,
        c.caps.con,
        c.enemyGrowths.hp,
        c.enemyGrowths.str,
        c.enemyGrowths.skl,
        c.enemyGrowths.spd,
        c.enemyGrowths.def,
        c.enemyGrowths.res,
        c.enemyGrowths.lck,
        c.promotionBonuses.hp,
        c.promotionBonuses.str,
        c.promotionBonuses.skl,
        c.promotionBonuses.spd,
        c.promotionBonuses.def,
        c.promotionBonuses.res,
        c.weaponLevels.sword,
        c.weaponLevels.lance,
        c.weaponLevels.axe,
        c.weaponLevels.bow,
        c.weaponLevels.staff,
        c.weaponLevels.anima,
        c.weaponLevels.light,
        c.weaponLevels.dark,
        json(c.abilityFlags),
        c.mount,
        c.specialAction,
        bit(c.flying),
        bit(c.terrainBonusImmune),
        bit(c.isEmpty),
      );
      for (const flag of c.abilityFlagIds) abilityFlags.add(c.id, flag);
      c.movementCosts.forEach((cost, terrainId) => moveCosts.add(c.id, terrainId, cost));
      if (c.terrainBonuses !== null) {
        c.terrainBonuses.avoid.forEach((avoid, terrainId) =>
          terrainBonuses.add(
            c.id,
            terrainId,
            avoid,
            c.terrainBonuses?.def[terrainId] ?? 0,
            c.terrainBonuses?.res[terrainId] ?? 0,
          ),
        );
      }
    }

    // Derived mobility; `movement`/`mount`/`specialAction` are on `classes`.
    for (const [classId, role] of rom.classRoles) {
      classRoles.add(
        classId,
        role.mobility,
        role.mobilitySource,
        json(role.weapons),
        bit(role.hasStaff),
        bit(role.isMagic),
      );
    }

    // -------------------------------------------------------------- supports
    for (const [id, name] of rom.affinityNames) affinities.add(id, name);
    for (const sb of rom.supportBonuses) {
      supportBonuses.add(
        sb.affinity,
        sb.bonuses.atk,
        sb.bonuses.def,
        sb.bonuses.hit,
        sb.bonuses.avoid,
        sb.bonuses.crit,
        sb.bonuses.critAvoid,
      );
    }
    for (const e of rom.supports.entries) {
      supportEntries.add(e.unitId, e.address, e.declaredCount, e.actualCount);
      for (const p of e.partners) supportPartners.add(e.unitId, p.unitId, p.initial, p.growth);
    }
    for (const e of rom.supportGraph) supportEdges.add(e.a, e.b, e.initial, e.growth);
    meta.add("supports.missingPointers", json(rom.supports.missing));

    // ----------------------------------------------------------------- items
    for (const i of rom.items) {
      items.add(
        i.id,
        i.addr,
        i.name,
        i.nameRaw,
        i.nameTextId,
        i.descTextId,
        i.useDescTextId,
        i.nameKind,
        json(i.nameUnknownCodes),
        i.desc,
        i.type,
        i.typeName,
        json(i.attributes),
        i.statBonusPointer,
        i.effectivenessPointer,
        i.uses,
        i.might,
        i.hit,
        i.weight,
        i.crit,
        i.rangeMin,
        i.rangeMax,
        i.weaponRank,
        i.iconId,
        i.staffEffect,
        i.damageBonus,
        i.wexp,
        i.unitPrice,
        bit(i.isWeapon),
      );
    }

    // --------------------------------------------------------------- terrain
    for (const t of rom.terrainNames.names) {
      terrains.add(t.id, t.name, t.textId, t.nameAddress, bit(t.decoded), json(t.raw));
    }

    // -------------------------------------------------------------- chapters
    for (const c of rom.chapters) {
      chapters.add(
        c.index,
        c.mapSettingAddr,
        c.chapterNumber,
        c.chapterNumberRaw,
        c.titleTextId,
        c.title,
        c.eventPlist,
        c.condTableAddr,
        json(c.condPointers),
        c.playerPlacementAddr,
        c.hardPlacementAddr,
        c.startEventAddr,
        c.endEventAddr,
        c.deploySlots,
        c.deploySlotsHard,
      );
      for (const [mode, list] of [
        ["normal", c.placements],
        ["hard", c.hardPlacements],
      ] as const) {
        list.forEach((p, position) =>
          placements.add(
            c.index,
            mode,
            position,
            p.addr,
            p.unitId,
            p.classId,
            p.commander,
            p.level,
            p.unitGrow,
            p.assign,
            p.side,
            p.autolevel,
            p.prePlacementCoord.x,
            p.prePlacementCoord.y,
            p.prePlacementCoord.ext,
            p.position,
            p.postPlacementCount,
            p.postPlacementAddr,
            json(p.items),
          ),
        );
      }
    }

    // ------------------------------------------------- story path and joins
    for (const e of rom.mapTransitions) {
      endEvents.add(e.mapIndex, e.endEventAddress, e.instructionsDecoded, e.stopReason);
      for (const t of e.transitions) {
        transitions.add(e.mapIndex, t.targetMap, t.opcode, t.scriptAddress, t.callDepth);
      }
    }
    for (const step of rom.playOrder.steps) {
      playOrder.add(step.mapIndex, step.order, step.role, bit(step.playable));
    }
    meta.add("playOrder.mainPath", json(rom.playOrder.mainPath));
    meta.add("playOrder.branches", json(rom.playOrder.branches));
    meta.add("playOrder.closedLoop", json(rom.playOrder.closedLoop));

    for (const [kind, map] of [
      ["join", rom.joins.joins],
      ["appearance", rom.joins.appearances],
    ] as const) {
      for (const [unitId, ev] of map) {
        unitJoins.add(
          unitId,
          kind,
          ev.chapterIndex,
          ev.storyOrder,
          ev.source,
          ev.evidenceAddr,
          bit(ev.classOverridden),
          ev.placedClassId,
        );
      }
    }

    // ---------------------------------------------------------- event scans
    for (const slot of rom.condSlots) condSlots.add(slot.index, slot.flag, slot.name, slot.kind);
    for (const scan of rom.chapterScans) {
      scanStats.add(scan.chapterIndex, scan.truncatedWalks);
      for (const r of scan.recruits) {
        recruits.add(
          scan.chapterIndex,
          r.addr,
          r.slotIndex,
          r.slotKind,
          r.instruction,
          r.kind,
          r.blockAddr,
          json(r.units.map((u) => u.unitId)),
        );
      }
      for (const g of scan.gold) gold.add(scan.chapterIndex, g.addr, g.delta, g.instruction);
      for (const g of scan.itemsGiven) {
        itemGives.add(scan.chapterIndex, g.addr, g.itemId, g.unitId, g.instruction);
      }
    }

    // ------------------------------------------- objects, shops, force sortie
    for (const co of rom.chapterObjects) {
      for (const o of co.objects) {
        mapObjects.add(
          co.chapterIndex,
          o.addr,
          o.type,
          o.kind,
          o.flag,
          o.objectType,
          o.objectTypeName,
          o.x,
          o.y,
          o.itemId,
          o.gold,
          bit(o.isGoldChest),
          o.eventAddr,
          o.shopAddr,
        );
      }
    }
    if (rom.shopData !== null) {
      rom.shopData.shops.forEach((shop, shopId) => {
        shops.add(
          shopId,
          shop.kind,
          shop.label,
          shop.addr,
          shop.mapIndex,
          shop.chapterNumber,
          shop.chapterTitle,
        );
        shop.entries.forEach((e, position) =>
          shopItems.add(shopId, position, e.itemId, e.uses, e.effectiveUses),
        );
      });
    }
    if (rom.forceSortie !== null) {
      for (const r of rom.forceSortie.records) {
        forceSortie.add(r.index, r.addr, r.unitId, r.route, r.mapIndex);
      }
    }

    // --------------------------------------------------------- enemy samples
    // Both autolevel modes, so normal-vs-hard is a WHERE clause, not a re-run.
    let unresolvedEnemyClasses = 0;
    for (const hard of [false, true]) {
      const { samples, unresolvedClass } = collectEnemyStats({
        rom: rom.rom,
        layout: rom.layout,
        eventScripts: rom.eventScripts,
        chapters: rom.chapters,
        condSlots: rom.condSlots,
        classes: rom.classes,
        units: rom.units,
        items: rom.items,
        hard,
      });
      unresolvedEnemyClasses = unresolvedClass;
      for (const s of samples) {
        enemySamples.add(
          hard ? "hard" : "normal",
          s.mapIndex,
          s.chapterNumber,
          s.addr,
          s.unitId,
          s.classId,
          s.level,
          s.grow,
          s.routine,
          bit(s.promoted),
          s.classBaseSpd,
          s.unitSpdDelta,
          s.spd.lo,
          s.spd.hi,
          s.spd.mean,
          s.con,
          s.weight,
          s.weightFirst,
          s.as.lo,
          s.as.hi,
          s.as.mean,
        );
      }
    }

    db.exec("COMMIT");
    return {
      tables: {
        meta: meta.count(),
        units: units.count(),
        classes: classes.count(),
        class_ability_flags: abilityFlags.count(),
        class_movement_costs: moveCosts.count(),
        class_terrain_bonuses: terrainBonuses.count(),
        class_roles: classRoles.count(),
        terrains: terrains.count(),
        affinities: affinities.count(),
        support_bonuses: supportBonuses.count(),
        support_entries: supportEntries.count(),
        support_partners: supportPartners.count(),
        support_edges: supportEdges.count(),
        items: items.count(),
        shops: shops.count(),
        shop_items: shopItems.count(),
        chapters: chapters.count(),
        chapter_placements: placements.count(),
        chapter_end_events: endEvents.count(),
        chapter_transitions: transitions.count(),
        play_order: playOrder.count(),
        unit_joins: unitJoins.count(),
        map_objects: mapObjects.count(),
        force_sortie: forceSortie.count(),
        cond_slots: condSlots.count(),
        chapter_recruits: recruits.count(),
        chapter_gold: gold.count(),
        chapter_item_gives: itemGives.count(),
        chapter_scan_stats: scanStats.count(),
        enemy_samples: enemySamples.count(),
      },
      unresolvedEnemyClasses,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
