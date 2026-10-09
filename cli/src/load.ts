/**
 * One-call ROM loading: identify the game, then resolve each table the first
 * time a command asks for it.
 *
 * Only the ROM buffer, the detected identity, the layout and the text context
 * are read eagerly - everything else is a memoised getter, so a command pays
 * for the tables it reads and nothing else. That matters because the tables
 * differ by two orders of magnitude in cost: `text` needs a 1 ms Huffman
 * context, while `chapterScans` walks every event script of every chapter and
 * takes ~650 ms on a 30 MB hack.
 *
 * Dependencies between getters are declared by reading the other getter, so
 * order in this file carries no meaning.
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
import { findConfigDataDir, languageSuffixes } from './config/data.ts';
import type { ClassFlagDef } from './tables/classFlags.ts';
import { loadClassFlags } from './tables/classFlags.ts';
import type { EventScriptTable, CondSlot } from './tables/eventScript.ts';
import { loadConditionSlots, loadEventScripts } from './tables/eventScript.ts';
import type {
  Chapter,
  ChapterScan,
  CondSlotInfo,
  JoinDerivation,
  MapSettingTable,
} from './tables/chapters.ts';
import {
  deriveJoins,
  describeCondSlots,
  readChapters,
  readMapSettingTable,
  scanChapter,
} from './tables/chapters.ts';
import type { ChapterEdges, PlayOrder } from './tables/storyPath.ts';
import { buildPlayOrder, isRealMap, readAllTransitions } from './tables/storyPath.ts';
import type { ForceSortieTable } from './tables/forceSortie.ts';
import { readForceSortie } from './tables/forceSortie.ts';
import type { Item, ItemReadResult } from './tables/items.ts';
import { buildItemMap, readItems } from './tables/items.ts';
import type { ShopReadResult } from './tables/shops.ts';
import { readShops } from './tables/shops.ts';
import type { ChapterObjects, MapObject } from './tables/mapObjects.ts';
import { readAllObjects } from './tables/mapObjects.ts';

/**
 * One ROM, parsed as far as the caller has asked for.
 *
 * Note on the shape: everything past `path` / `rom` / `identity` / `layout` /
 * `text` is installed as a **non-enumerable memoised getter**, not a data
 * field. Reading one parses that table; nothing else does. They are
 * deliberately non-enumerable so that `JSON.stringify(rom)` or `{ ...rom }`
 * - which would otherwise force every table, including the ~650 ms
 * `chapterScans` walk - silently yields only the eager fields instead of
 * quietly doing minutes of work.
 */
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
  /**
   * The `--lang` value this ROM was loaded with, or `null` for the default.
   * Reported by `info` so a surprising name in the output can be traced to a
   * language choice rather than guessed at.
   */
  configLanguage: string | null;
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
  /**
   * Each chapter's END_EVENT decoded into outgoing transitions. The input to
   * `playOrder`; also the per-map edge list in its own right.
   */
  mapTransitions: ChapterEdges[];
  /**
   * The order the chapters are played in, main path and side chapters together.
   * This - not `chapterNumber` - is what orders the game; see
   * `tables/storyPath.ts`.
   */
  playOrder: PlayOrder;
  /** Per-chapter recruit scan. Empty when the opcode table is missing. */
  chapterScans: ChapterScan[];
  /** Earliest chapter per unit id, ordered by `playOrder`. */
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
  /**
   * `--lang` value for the `config/data` name tables (`en` / `ja` / `zh`).
   * Defaults to English - see `config/data.ts` for why this differs from
   * FEBuilderGBA's own order.
   */
  language?: string;
  /**
   * Where to send the "config/data is missing" warning. Defaults to stderr.
   * Pass a no-op to stay quiet (library use).
   */
  warn?: (message: string) => void;
}

export class UnsupportedRomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedRomError';
  }
}

/**
 * The ROM file could not be read at all - missing, unreadable, a directory.
 * Distinct from `UnsupportedRomError` because the user can fix it by fixing
 * the path, and it deserves a one-line message rather than a stack trace.
 */
export class RomNotFoundError extends Error {
  // Written out rather than as constructor parameter properties: Node's type
  // stripping erases types, and a parameter property is a *runtime* construct
  // it cannot erase.
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`cannot read ROM file: ${reason}`);
    this.name = 'RomNotFoundError';
    this.path = path;
    this.reason = reason;
  }
}

/** `FE8U` -> `FE8`. FEBuilderGBA's `TitleToFilename` fragment. */
export function titleFragment(version: string): string {
  return version.slice(0, 3);
}

/**
 * A property that computes itself once, on first read.
 *
 * Non-enumerable on purpose - see the `LoadedRom` doc comment. Reading is
 * still the only way to get a value; you just cannot enumerate your way into
 * computing all of them.
 */
function memo<T>(compute: () => T): PropertyDescriptor {
  let done = false;
  let value: T;
  return {
    enumerable: false,
    configurable: true,
    get(): T {
      if (!done) {
        value = compute();
        done = true;
      }
      return value;
    },
  };
}

/**
 * Which classes are already promoted.
 *
 * NOT via `promotesToClassId`: in a base/promoted pair that field links the two
 * ids **both ways** (verified on FE8U - `Brawler`(1) stores 3 and `Great
 * Chief`(3) stores 1; same for 5/7, 9/11, 15/17), so it cannot break the tie.
 * `sortOrder` can: verified across 9 pairs, the **higher** value is always the
 * promoted side (Brawler=1 / Great Chief=2, Sword Pegasus=16 / Falcoknight=17,
 * Swd Mercenary=3 / Hero=4).
 *
 * My partner is whatever `promotesToClassId` names. If my partner sorts higher
 * than I do, *it* is the promoted one and I am still base.
 */
function promotedClassIdsOf(classes: readonly UnitClass[]): Set<number> {
  const promoted = new Set<number>();
  for (const c of classes) {
    const target = classes.find((o) => o.id === c.promotesToClassId);
    if (target && target.sortOrder < c.sortOrder) promoted.add(c.id);
  }
  return promoted;
}

export function loadRom(path: string, options: LoadOptions = {}): LoadedRom {
  // A wrong path is the most common way to invoke this CLI wrong, so it gets a
  // message instead of Node's stack trace.
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new RomNotFoundError(path, 'no such file');
    if (code === 'EISDIR') throw new RomNotFoundError(path, 'is a directory');
    if (code === 'EACCES') throw new RomNotFoundError(path, 'permission denied');
    throw new RomNotFoundError(path, (error as Error).message);
  }
  const buffer = new RomBuffer(bytes);
  const identity = detectVersion(buffer);

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

  // Only what every command needs, and all of it cheap: `makeTextContext` sets
  // up the Huffman tables without decoding anything.
  const text = makeTextContext(buffer, layout.text);
  const game = titleFragment(identity.version);
  const warn = options.warn ?? ((message: string) => console.error(`warning: ${message}`));
  const language = options.language;
  if (language !== undefined && languageSuffixes(language) === null) {
    // loadRom is also a library entry point, so it cannot assume the CLI
    // validated `--lang` first.
    warn(`unknown --lang "${language}"; falling back to the default language`);
  }
  // Only warn once, and only about the directory: a missing *file* for this
  // particular game is reported by whichever table turns up empty.
  let warnedNoConfig = false;
  const requireConfigDir = (): string | null => {
    const dir = self.configDir;
    if (dir === null && !warnedNoConfig) {
      warnedNoConfig = true;
      warn(
        'config/data not found - class ability names, the event-script opcode ' +
          'table and the chapter-condition names are all unavailable, so ' +
          '`chapters`, `roles` mobility and `units` availability will be empty ' +
          'or fall back to heuristics. Set FEBUILDERGBA_CONFIG or pass ' +
          'configDir to fix this.',
      );
    }
    return dir;
  };
  const self = { path, rom: buffer, identity, layout, text } as unknown as LoadedRom;

  Object.defineProperties(self, {
    // `config/data` supplies the names of class ability bits and the opcode
    // table. Without it we can still parse, but roles lose the mounted/armour
    // distinction and the chapters lose their script walks.
    configDir: memo(() => findConfigDataDir(options.configDir)),
    configLanguage: memo(() => options.language ?? null),
    classFlagDefs: memo(() => {
      const dir = requireConfigDir();
      return dir === null ? [] : loadClassFlags(dir, game, language);
    }),

    classTable: memo(() => resolveTable(buffer, layout.unitClass)),
    classes: memo(() =>
      readAllClasses({
        rom: buffer,
        table: self.classTable,
        text,
        abilityFlagDefs: self.classFlagDefs,
      }),
    ),
    classNames: memo(() => buildClassNameMap(self.classes)),
    classRoles: memo(() => deriveClassRoles(self.classes)),

    unitTable: memo(() => resolveTable(buffer, layout.unit)),
    units: memo(() => {
      // Class base stats turn a unit's per-unit deltas into the stats it
      // actually starts with (`startingStat = class base + unit base`).
      const classBases = new Map(self.classes.map((c) => [c.id, c.bases]));
      return readAllUnits({
        rom: buffer,
        table: self.unitTable,
        text,
        classNames: self.classNames,
        classBases,
        promotedClassIds: promotedClassIdsOf(self.classes),
      });
    }),
    unitNames: memo(() => buildUnitNameMap(self.units)),

    supports: memo(() => readSupports(buffer, self.units, self.unitNames)),
    supportGraph: memo(() => buildSupportGraph(self.supports.entries, self.unitNames)),
    supportBonuses: memo(() =>
      layout.support ? readSupportBonuses(buffer, layout.support.attributePointer) : [],
    ),
    // Affinity names straight from the ROM's text table, via the text ids the
    // game's own `GetAffinityName` uses. Falls back per-entry to the hardcoded
    // table when a text id does not decode.
    affinityNames: memo(() => readAffinityNames(buffer, text)),

    terrainNames: memo(() => readTerrainNames(buffer, layout.terrainNames, text)),

    eventScripts: memo(() => {
      const dir = requireConfigDir();
      return dir === null ? { scripts: [], source: null } : loadEventScripts(dir, game, language);
    }),
    rawCondSlots: memo(() => {
      const dir = requireConfigDir();
      return dir === null ? [] : loadConditionSlots(dir, game, language);
    }),
    condSlots: memo(() => describeCondSlots(self.rawCondSlots)),

    mapSettings: memo(() => readMapSettingTable(buffer, layout)),
    chapters: memo(() => {
      const settings = self.mapSettings;
      const slots = self.condSlots;
      return settings === null || slots.length === 0
        ? []
        : readChapters(buffer, layout, settings, slots, text);
    }),

    mapTransitions: memo(() =>
      self.eventScripts.scripts.length === 0
        ? []
        : readAllTransitions(buffer, self.eventScripts, self.chapters),
    ),
    playOrder: memo(() => {
      const real = new Set(
        self.chapters.filter((c) => isRealMap(buffer, c)).map((c) => c.index),
      );
      return buildPlayOrder(self.mapTransitions, (m) => real.has(m));
    }),

    chapterScans: memo(() =>
      self.eventScripts.scripts.length === 0
        ? []
        : self.chapters.map((c) => scanChapter(buffer, self.eventScripts, layout, c, self.condSlots)),
    ),
    joins: memo(() => {
      const ownClassOf = new Map<number, number>();
      for (const unit of self.units) {
        if (unit.classId !== undefined) ownClassOf.set(unit.id, unit.classId);
      }
      const position = self.playOrder.position;
      return deriveJoins(self.chapters, self.chapterScans, ownClassOf, (m) => position.get(m) ?? null);
    }),

    forceSortie: memo(() => readForceSortie(buffer, layout)),

    // Items come first: shop entries are priced through them, and map objects
    // only need the chapter list.
    itemData: memo(() => (layout.item === null ? null : readItems(buffer, layout.item, text))),
    items: memo(() => self.itemData?.items ?? []),
    itemMap: memo(() => buildItemMap(self.items)),

    chapterObjects: memo(() => readAllObjects(buffer, layout, self.chapters)),
    mapObjects: memo(() => self.chapterObjects.flatMap((c) => c.objects)),
    shopData: memo(() =>
      layout.shop === null || self.items.length === 0
        ? null
        : readShops(buffer, layout.shop, self.chapterObjects, self.itemMap),
    ),
  });

  return self;
}
