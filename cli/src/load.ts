/**
 * One-call ROM loading: identify the game, resolve every table, decode text,
 * and hand back ready-to-use data.
 *
 * Order matters - classes are read before units because unit output embeds
 * class names.
 */

import { readFileSync } from 'node:fs';

import { RomBuffer } from './rom/RomBuffer.ts';
import type { RomIdentity } from './rom/detect.ts';
import { detectVersion } from './rom/detect.ts';
import type { GameLayout } from './data/layouts.ts';
import { getLayout } from './data/layouts.ts';
import type { TextContext } from './text/huffman.ts';
import { makeTextContext } from './text/huffman.ts';
import type { ResolvedTable } from './tables/common.ts';
import { resolveTable } from './tables/common.ts';
import type { UnitClass } from './tables/classes.ts';
import { buildClassNameMap, readAllClasses } from './tables/classes.ts';
import type { Unit } from './tables/units.ts';
import { buildUnitNameMap, readAllUnits } from './tables/units.ts';
import type { SupportGraphEdge, SupportReadResult } from './tables/supports.ts';
import { buildSupportGraph, readSupports } from './tables/supports.ts';
import type { SupportBonus } from './tables/supportBonus.ts';
import { readAffinityNames, readSupportBonuses } from './tables/supportBonus.ts';
import type { TerrainReadResult } from './tables/terrainNames.ts';
import { readTerrainNames } from './tables/terrainNames.ts';
import type { ClassRole } from './tables/classRoles.ts';
import { deriveClassRoles } from './tables/classRoles.ts';
import { findConfigDataDir } from './config/data.ts';
import type { ClassFlagDef } from './tables/classFlags.ts';
import { loadClassFlags } from './tables/classFlags.ts';
import type { EventScriptTable, CondSlot } from './tables/eventScript.ts';
import { loadConditionSlots, loadEventScripts } from './tables/eventScript.ts';
import type { Chapter, ChapterScan, CondSlotInfo, JoinDerivation, MapSettingTable } from './tables/chapters.ts';
import {
  deriveJoins,
  describeCondSlots,
  readChapters,
  readMapSettingTable,
  scanChapter,
} from './tables/chapters.ts';
import type { ForceSortieTable } from './tables/forceSortie.ts';
import { readForceSortie } from './tables/forceSortie.ts';
import type { Item, ItemReadResult } from './tables/items.ts';
import { buildItemMap, readItems } from './tables/items.ts';
import type { ShopReadResult } from './tables/shops.ts';
import { readShops } from './tables/shops.ts';
import type { ChapterObjects, MapObject } from './tables/mapObjects.ts';
import { readAllObjects } from './tables/mapObjects.ts';

export interface LoadedRom {
  path: string;
  rom: RomBuffer;
  identity: RomIdentity;
  layout: GameLayout;
  text: TextContext;
  classTable: ResolvedTable;
  unitTable: ResolvedTable;
  classes: UnitClass[];
  classNames: Map<number, string>;
  /** Role profile (weapons, staff/magic, terrain mobility) per class id. */
  classRoles: Map<number, ClassRole>;
  units: Unit[];
  unitNames: Map<number, string>;
  supports: SupportReadResult;
  supportGraph: SupportGraphEdge[];
  /** Support-affinity bonus table. See `tables/supportBonus.ts` for caveats. */
  supportBonuses: SupportBonus[];
  /** Affinity id (1..7) -> name, decoded from the ROM's own text ids. */
  affinityNames: Map<number, string>;
  /**
   * Terrain names, indexed by the same terrain id a class's movement-cost
   * table uses. See `tables/terrainNames.ts`.
   */
  terrainNames: TerrainReadResult;
  /** Resolved `config/data` directory, or `null` when not found. */
  configDir: string | null;
  /** Class ability-flag definitions; empty when `config/data` is missing. */
  classFlagDefs: ClassFlagDef[];
  /** Event-script opcode table; empty when `config/data` is missing. */
  eventScripts: EventScriptTable;
  /** Condition-slot descriptions from `eventcond_<game>.txt`. */
  condSlots: CondSlotInfo[];
  /** Raw condition slots, before the kind is resolved. */
  rawCondSlots: CondSlot[];
  /** Map-setting table, or `null` when the game layout has no map section. */
  mapSettings: MapSettingTable | null;
  /** One entry per map setting record. */
  chapters: Chapter[];
  /** Per-chapter recruit scan. Empty when the opcode table is missing. */
  chapterScans: ChapterScan[];
  /** Earliest chapter per unit id. */
  joins: JoinDerivation;
  /**
   * Forced-deployment ("必ず出撃") table, or `null` when the game has none.
   * See `tables/forceSortie.ts` for the recovered record layout.
   */
  forceSortie: ForceSortieTable | null;
  /** Item table read result, or `null` when the game layout has none. */
  itemData: ItemReadResult | null;
  /** One entry per item id; index 0 is the empty slot. */
  items: Item[];
  /** Item id -> item, for shop/unit lookups. */
  itemMap: Map<number, Item>;
  /** Shops (prep screen + per-map), or `null` when the game layout has none. */
  shopData: ShopReadResult | null;
  /** Chests, villages, doors and seize points, one entry per chapter. */
  chapterObjects: ChapterObjects[];
  /** Every map object across all chapters, flattened. */
  mapObjects: MapObject[];
}

export interface LoadOptions {
  /**
   * Explicit `config/data` directory. Defaults to the vendored `cli/data/`
   * copy (see `config/data.ts`); override only to test against an upstream tree.
   */
  configDir?: string;
}

export class UnsupportedRomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedRomError';
  }
}

/** `FE8U` -> `FE8`. FEBuilderGBA's `TitleToFilename` fragment. */
export function titleFragment(version: string): string {
  return version.slice(0, 3);
}

export function loadRom(path: string, options: LoadOptions = {}): LoadedRom {
  const rom = new RomBuffer(readFileSync(path));
  const identity = detectVersion(rom);

  if (!identity.version) {
    // `detectVersion` already explains why (too small, or an unknown code).
    throw new UnsupportedRomError(
      `${identity.notes.join(' ')} ` +
        'Supported game codes: AFEJ01 (FE6J), AE7J01 (FE7J), AE7E01 (FE7U), ' +
        'BE8J01 (FE8J), BE8E01 (FE8U).',
    );
  }

  const layout = getLayout(identity.version);
  if (!layout.supported) {
    throw new UnsupportedRomError(
      `${layout.displayName} is not supported yet. ${layout.unsupportedReason ?? ''}`.trim(),
    );
  }

  const text = makeTextContext(rom, layout.text);

  // `config/data` supplies the names of class ability bits. Without it we can
  // still parse, but roles lose the mounted/armour distinction.
  const configDir = findConfigDataDir(options.configDir);
  const classFlagDefs =
    configDir === null ? [] : loadClassFlags(configDir, titleFragment(identity.version));

  const classTable = resolveTable(rom, layout.unitClass);
  const classes = readAllClasses({ rom, table: classTable, text, abilityFlagDefs: classFlagDefs });
  const classNames = buildClassNameMap(classes);
  const classRoles = deriveClassRoles(classes);

  const unitTable = resolveTable(rom, layout.unit);
  // Class base stats are needed to turn a unit's per-unit deltas into the stats
  // it actually starts with (`startingStat = class base + unit base`).
  const classBases = new Map(classes.map((c) => [c.id, c.bases]));
  // Which classes are already promoted?
  //
  // NOT via `promotesToClassId`: in a base/promoted pair that field links the
  // two ids **both ways** (verified on FE8U - `Brawler`(1) stores 3 and
  // `Great Chief`(3) stores 1; same for 5/7, 9/11, 15/17), so it cannot
  // break the tie. `sortOrder` can: verified across 9 pairs, the **higher**
  // value is always the promoted side (Brawler=1 / Great Chief=2,
  // Sword Pegasus=16 / Falcoknight=17, Swd Mercenary=3 / Hero=4).
  //
  // My partner is whatever `promotesToClassId` names. If my partner sorts
  // higher than I do, *it* is the promoted one and I am still base.
  const promotedClassIds = new Set<number>();
  for (const c of classes) {
    const target = classes.find((o) => o.id === c.promotesToClassId);
    if (target && target.sortOrder < c.sortOrder) promotedClassIds.add(c.id);
  }
  const units = readAllUnits({
    rom,
    table: unitTable,
    text,
    classNames,
    classBases,
    promotedClassIds,
  });
  const unitNames = buildUnitNameMap(units);

  const supports = readSupports(rom, units, unitNames);
  const supportGraph = buildSupportGraph(supports.entries, unitNames);

  const supportBonuses = layout.support
    ? readSupportBonuses(rom, layout.support.attributePointer)
    : [];

  // Affinity names straight from the ROM's text table, via the text ids the
  // game's own `GetAffinityName` uses. Falls back per-entry to the hardcoded
  // table when a text id does not decode.
  const affinityNames = readAffinityNames(rom, text);

  const terrainNames = readTerrainNames(rom, layout.terrainNames, text);

  // Chapters and join order. Both need `config/data`: the opcode table to walk
  // scripts, and `eventcond_<game>.txt` to know which condition slot is which.
  const game = titleFragment(identity.version);
  const eventScripts =
    configDir === null ? { scripts: [], source: null } : loadEventScripts(configDir, game);
  const rawCondSlots = configDir === null ? [] : loadConditionSlots(configDir, game);
  const condSlots = describeCondSlots(rawCondSlots);

  const mapSettings = readMapSettingTable(rom, layout);
  const chapters =
    mapSettings === null || condSlots.length === 0
      ? []
      : readChapters(rom, layout, mapSettings, condSlots, text);

  const chapterScans =
    eventScripts.scripts.length === 0
      ? []
      : chapters.map((chapter) => scanChapter(rom, eventScripts, layout, chapter, condSlots));

  const ownClassOf = new Map<number, number>();
  for (const unit of units) {
    if (unit.classId !== undefined) ownClassOf.set(unit.id, unit.classId);
  }
  const joins = deriveJoins(chapters, chapterScans, ownClassOf);

  const forceSortie = readForceSortie(rom, layout);

  // Items and shops. Items come first: shop entries are priced through them.
  const itemData = layout.item === null ? null : readItems(rom, layout.item, text);
  const items = itemData?.items ?? [];
  const itemMap = buildItemMap(items);

  // Map objects (chest / village / door / seize / shop) are read once; the shop
  // reader only turns the shop-typed ones into priced entry lists.
  const chapterObjects = readAllObjects(rom, layout, chapters);
  const mapObjects = chapterObjects.flatMap((c) => c.objects);

  const shopData =
    layout.shop === null || items.length === 0
      ? null
      : readShops(rom, layout.shop, chapterObjects, itemMap);

  return {
    path,
    rom,
    identity,
    layout,
    text,
    classTable,
    unitTable,
    classes,
    classNames,
    classRoles,
    units,
    unitNames,
    supports,
    supportGraph,
    supportBonuses,
    affinityNames,
    terrainNames,
    configDir,
    classFlagDefs,
    eventScripts,
    condSlots,
    rawCondSlots,
    mapSettings,
    chapters,
    chapterScans,
    joins,
    forceSortie,
    itemData,
    items,
    itemMap,
    shopData,
    chapterObjects,
    mapObjects,
  };
}
