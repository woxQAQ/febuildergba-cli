/**
 * ROM loading, in two stages with an explicit cost split.
 *
 * `loadRom` reads the file and identifies the game - cheap, and all the
 * `text` command needs. `parseRom` reads every table the extractor persists;
 * it exists separately because a full parse walks every event script of
 * every chapter (~650 ms on a 30 MB hack), which a diagnostic like `text`
 * should not have to pay for. The two granularities are "identity" and
 * "everything"; there is deliberately no lazy middle layer between them.
 */

import { readFileSync } from "node:fs";

import { RomBuffer } from "./rom/RomBuffer.ts";
import type { GameVersion, RomIdentity } from "./rom/detect.ts";
import { detectVersion, MIN_ROM_SIZES } from "./rom/detect.ts";
import type { GameLayout } from "./data/layouts.ts";
import { getLayout } from "./data/layouts.ts";
import type { TextContext } from "./text/huffman.ts";
import { makeTextContext } from "./text/huffman.ts";
import { resolveTable } from "./tables/common.ts";
import type { UnitClass } from "./tables/classes.ts";
import { buildClassNameMap, readAllClasses } from "./tables/classes.ts";
import type { Unit } from "./tables/units.ts";
import { buildUnitNameMap, readAllUnits } from "./tables/units.ts";
import type { SupportReadResult } from "./tables/supports.ts";
import { readSupports } from "./tables/supports.ts";
import type { SupportBonus } from "./tables/supportBonus.ts";
import { readAffinityNames, readSupportBonuses } from "./tables/supportBonus.ts";
import type { TerrainReadResult } from "./tables/terrainNames.ts";
import { readTerrainNames } from "./tables/terrainNames.ts";
import { findConfigDataDir, isKnownLanguage } from "./config/data.ts";
import { loadClassFlags } from "./tables/classFlags.ts";
import type { EventScriptTable } from "./tables/eventScript.ts";
import { loadConditionSlots, loadEventScripts } from "./tables/eventScript.ts";
import type { Chapter, CondSlotInfo, MapSettingTable } from "./tables/chapters.ts";
import { describeCondSlots, readChapters, readMapSettingTable } from "./tables/chapters.ts";
import type { PlayOrder } from "./tables/storyPath.ts";
import { buildPlayOrder, isRealMap, readAllTransitions } from "./tables/storyPath.ts";
import type { ForceSortieTable } from "./tables/forceSortie.ts";
import { readForceSortie } from "./tables/forceSortie.ts";
import type { Item, ItemReadResult } from "./tables/items.ts";
import {
  buildItemMap,
  loadItemEffectNames,
  readItems,
  readPromotionTables,
} from "./tables/items.ts";
import type { SkillReadResult } from "./tables/skills.ts";
import { readSkills } from "./tables/skills.ts";
import type { ShopReadResult } from "./tables/shops.ts";
import { readShops } from "./tables/shops.ts";
import type { ChapterObjects } from "./tables/mapObjects.ts";
import { readAllObjects } from "./tables/mapObjects.ts";

/**
 * An identified ROM: the file, which game it is, the pointer layout for that
 * game and a ready text decoder. Nothing here walks a table.
 */
export interface RomHandle {
  path: string;
  rom: RomBuffer;
  identity: RomIdentity & { version: GameVersion };
  layout: GameLayout;
  text: TextContext;
}

/**
 * A fully parsed ROM: the handle plus every table the extractor persists.
 * Building this is the ~650 ms the `text` command avoids by stopping at
 * {@link RomHandle}.
 */
export interface ParsedRom extends RomHandle {
  /** Resolved `config/data` directory, or `null` when not found. */
  configDir: string | null;
  /**
   * The `--lang` value this ROM was parsed with, or `null` for the default.
   * Recorded in the db's `meta` table so a surprising name in the output can
   * be traced to a language choice rather than guessed at.
   */
  configLanguage: string | null;
  classes: UnitClass[];
  units: Unit[];
  supports: SupportReadResult;
  /** Support-affinity bonus table. See `tables/supportBonus.ts` for caveats. */
  supportBonuses: SupportBonus[];
  /** Affinity id (1..7) -> name, decoded from the ROM's own text ids. */
  affinityNames: Map<number, string>;
  /**
   * Terrain names, indexed by the same terrain id a class's movement-cost
   * table uses. See `tables/terrainNames.ts`.
   */
  terrainNames: TerrainReadResult;
  /** Condition-slot descriptions from `eventcond_<game>.txt`. */
  condSlots: CondSlotInfo[];
  /** Event-script opcode table; empty when `config/data` is missing. */
  eventScripts: EventScriptTable;
  /** One entry per map setting record. */
  chapters: Chapter[];
  /**
   * The order the chapters are played in, main path and side chapters together.
   * This - not `chapterNumber` - is what orders the game; see
   * `tables/storyPath.ts`.
   */
  playOrder: PlayOrder;
  /**
   * Forced-deployment ("必ず出撃") table, or `null` when the game has none.
   * See `tables/forceSortie.ts` for the recovered record layout.
   */
  forceSortie: ForceSortieTable | null;
  /** One entry per item id; index 0 is the empty slot. */
  items: Item[];
  /** Shops (prep screen + per-map), or `null` when the game layout has none. */
  shopData: ShopReadResult | null;
  /** Chests, villages, doors and seize points, one entry per chapter. */
  chapterObjects: ChapterObjects[];
  /**
   * Skill tables, or `null` when the ROM carries no decodable skill system.
   * See `tables/skills.ts` - `null` means "no skills", not "parse failed".
   */
  skills: SkillReadResult | null;
}

export interface ParseOptions {
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
    this.name = "UnsupportedRomError";
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
    this.name = "RomNotFoundError";
    this.path = path;
    this.reason = reason;
  }
}

/** `FE8U` -> `FE8`. FEBuilderGBA's `TitleToFilename` fragment. */
function titleFragment(version: string): string {
  return version.slice(0, 3);
}

/**
 * Read the ROM file and identify the game. Throws `RomNotFoundError` for an
 * unreadable path and `UnsupportedRomError` for a file that is not a
 * supported ROM - both carry a one-line message, not a stack trace.
 */
export function loadRom(path: string): RomHandle {
  // A wrong path is the most common way to invoke this CLI wrong, so it gets a
  // message instead of Node's stack trace.
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new RomNotFoundError(path, "no such file");
    if (code === "EISDIR") throw new RomNotFoundError(path, "is a directory");
    if (code === "EACCES") throw new RomNotFoundError(path, "permission denied");
    throw new RomNotFoundError(path, (error as Error).message);
  }
  const buffer = new RomBuffer(bytes);
  const identity = detectVersion(buffer);

  if (!identity.version) {
    // `detectVersion` already explains why (too small, or an unknown code).
    throw new UnsupportedRomError(
      `${identity.notes.join(" ")} ` +
        "Supported game codes: AFEJ01 (FE6J), AE7J01 (FE7J), AE7E01 (FE7U), " +
        "BE8J01 (FE8J), BE8E01 (FE8U).",
    );
  }

  // `detectVersion` already knows the file is too short for the game it claims
  // to be. Failing here turns what would otherwise be a `RangeError: read out
  // of range` from some table read deep in a command into exit 1 with a reason
  // the user can act on.
  if (!identity.sizeOk) {
    const min = MIN_ROM_SIZES[identity.version];
    throw new UnsupportedRomError(
      `ROM is ${identity.size} bytes but ${identity.version} needs at least ` +
        `${min} (0x${min.toString(16).toUpperCase()}). The file is truncated or ` +
        "was patched onto a trimmed base; no table in it can be read safely.",
    );
  }

  const layout = getLayout(identity.version);
  if (!layout.supported) {
    throw new UnsupportedRomError(
      `${layout.displayName} is not supported yet. ${layout.unsupportedReason ?? ""}`.trim(),
    );
  }

  // `makeTextContext` sets up the Huffman tables without decoding anything.
  // The checks above narrowed `version`: a returned handle is always a known
  // game, which is why `RomHandle.identity.version` is not nullable.
  const version = identity.version;
  return {
    path,
    rom: buffer,
    identity: { ...identity, version },
    layout,
    text: makeTextContext(buffer, layout.text),
  };
}

/**
 * Which classes are already promoted. NOT via `promotesToClassId`: in a
 * base/promoted pair that field links **both ways** (FE8U: `Brawler`(1)<->3,
 * 5/7, 9/11, 15/17), so it cannot break the tie. `sortOrder` can: across 9
 * pairs the **higher** value is the promoted side. If `promotesToClassId`'s
 * target sorts higher than self, self is still base.
 */
function promotedClassIdsOf(classes: readonly UnitClass[]): Set<number> {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const promoted = new Set<number>();
  for (const c of classes) {
    const target = byId.get(c.promotesToClassId);
    if (target && target.sortOrder < c.sortOrder) promoted.add(c.id);
  }
  return promoted;
}

/**
 * Read every table the extractor persists. Statement order carries the
 * dependencies: units need class bases (stats are signed deltas on them), shops
 * need items (entries are priced through them), shops and chapters need the
 * object walk. Called once, by `extract`; nothing is memoised.
 */
export function parseRom(handle: RomHandle, options: ParseOptions = {}): ParsedRom {
  const { rom: buffer, layout, text } = handle;
  const game = titleFragment(handle.identity.version);
  const warn = options.warn ?? ((message: string) => console.error(`warning: ${message}`));
  const language = options.language;
  if (language !== undefined && !isKnownLanguage(language)) {
    // parseRom is also a library entry point, so it cannot assume the CLI
    // validated `--lang` first. Same predicate as the CLI raises on - see
    // `isKnownLanguage`; only the response differs (warn, not exit 2).
    warn(`unknown --lang "${language}"; falling back to the default language`);
  }

  // `config/data` supplies the names of class ability bits and the opcode
  // table. Without it we can still parse, but the event-script walks and the
  // chapter-condition names are unavailable, and an extract leaves the related
  // tables empty.
  const configDir = findConfigDataDir(options.configDir);
  if (configDir === null) {
    warn(
      "config/data not found - the vendored cli/data directory is missing, so " +
        "class ability names, the event-script opcode table and the " +
        "chapter-condition names are all unavailable and an extract leaves " +
        "the related tables empty. Library callers can pass configDir to " +
        "supply a tree.",
    );
  }

  const classFlagDefs = configDir === null ? [] : loadClassFlags(configDir, game, language);
  const classes = readAllClasses({
    rom: buffer,
    table: resolveTable(buffer, layout.unitClass),
    text,
    abilityFlagDefs: classFlagDefs,
  });

  const units = readAllUnits({
    rom: buffer,
    table: resolveTable(buffer, layout.unit),
    text,
    classNames: buildClassNameMap(classes),
    // Class base stats turn a unit's per-unit deltas into the stats it
    // actually starts with (`startingStat = class base + unit base`).
    classBases: new Map(classes.map((c) => [c.id, c.bases])),
    promotedClassIds: promotedClassIdsOf(classes),
  });
  const supports = readSupports(buffer, units, buildUnitNameMap(units));
  const supportBonuses = layout.support
    ? readSupportBonuses(buffer, layout.support.attributePointer)
    : [];
  // Affinity names straight from the ROM's text table, via the text ids the
  // game's own `GetAffinityName` uses. Falls back per-entry to the hardcoded
  // table when a text id does not decode.
  const affinityNames = readAffinityNames(buffer, text);
  const terrainNames = readTerrainNames(buffer, layout.terrainNames, text);

  const eventScripts: EventScriptTable =
    configDir === null
      ? { scripts: [], source: null }
      : loadEventScripts(configDir, game, language);
  const condSlots = describeCondSlots(
    configDir === null ? [] : loadConditionSlots(configDir, game, language),
  );

  const mapSettings: MapSettingTable | null = readMapSettingTable(buffer, layout);
  const chapters =
    mapSettings === null || condSlots.length === 0
      ? []
      : readChapters(buffer, layout, mapSettings, condSlots, text);

  const transitions =
    eventScripts.scripts.length === 0 ? [] : readAllTransitions(buffer, eventScripts, chapters);
  const realMaps = new Set(chapters.filter((c) => isRealMap(buffer, c)).map((c) => c.index));
  const playOrder = buildPlayOrder(transitions, (m) => realMaps.has(m));

  const forceSortie = readForceSortie(buffer, layout);

  // Items come first: shop entries are priced through them, and map objects
  // only need the chapter list. The `+30` use-effect names come from
  // `config/data`; the promotion class lists come from the ROM itself.
  const itemEffectNames =
    configDir === null ? null : loadItemEffectNames(configDir, game, language);
  const promotionTables =
    layout.promotion === null ? null : readPromotionTables(buffer, layout.promotion);
  const itemData: ItemReadResult | null =
    layout.item === null
      ? null
      : readItems(buffer, layout.item, text, itemEffectNames, promotionTables);
  const items = itemData?.items ?? [];
  const chapterObjects = readAllObjects(buffer, layout, chapters);
  const shopData =
    layout.shop === null || items.length === 0
      ? null
      : readShops(buffer, layout.shop, chapterObjects, buildItemMap(items));

  // Skills last: the tables are independent of everything above, and this is
  // the only reader that searches the ROM for signatures rather than
  // dereferencing a known slot.
  const skills = readSkills({
    rom: buffer,
    skillSystem: handle.identity.skillSystem,
    unitCount: units.length,
    classCount: classes.length,
    text,
  });

  return {
    ...handle,
    configDir,
    configLanguage: language ?? null,
    classes,
    units,
    supports,
    supportBonuses,
    affinityNames,
    terrainNames,
    condSlots,
    eventScripts,
    chapters,
    playOrder,
    forceSortie,
    items,
    shopData,
    chapterObjects,
    skills,
  };
}
