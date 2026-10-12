/**
 * ROM loading, in one stage: read the file, identify the game, read every table
 * the extractor persists.
 *
 * It used to be two (`loadRom` for the identity, `parseRom` for everything), so
 * that a diagnostic like `text` would not pay the ~650 ms a full parse costs on
 * a 30 MB hack. `text` was the only consumer of the cheap half, and it needs
 * nothing from the parse stage - it wants a text decoder, which
 * `tables/huffman.ts` builds from a buffer and a layout. That is `text`'s own
 * dependency, not a second granularity of ROM loading; the split, the two
 * entry points and the two types it required were the cost of pretending
 * otherwise.
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
import { buildClassNameMap, buildPromotionGraph, readAllClasses } from "./tables/classes.ts";
import type { Unit } from "./tables/units.ts";
import { buildUnitNameMap, readAllUnits } from "./tables/units.ts";
import type { SupportReadResult } from "./tables/supports.ts";
import { readSupports } from "./tables/supports.ts";
import type { SupportBonus } from "./tables/supportBonus.ts";
import { readAffinityNames, readSupportBonuses } from "./tables/supportBonus.ts";
import type { TerrainReadResult } from "./tables/terrainNames.ts";
import { readTerrainNames } from "./tables/terrainNames.ts";
import { DEFAULT_LANGUAGE, findConfigDataDir, isKnownLanguage } from "./config/data.ts";
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
import type { EventTrace } from "./tables/eventTrace.ts";
import { eventDecodeWarning, extractEventTrace } from "./tables/eventTrace.ts";

/**
 * The ROM plus what `text` needs to decode it: no table walk, no
 * `config/data`. Separate from `load` because it is a different dependency set,
 * not a cheaper granularity of the same one - decoding a text id needs the
 * Huffman context, which is built from the buffer and the layout.
 */
export interface LoadedRom {
  path: string;
  rom: RomBuffer;
  identity: RomIdentity & { version: GameVersion };
  layout: GameLayout;
  text: TextContext;
}

/**
 * Read the ROM file and identify the game: every check `load` performs, minus
 * the parse. Throws `RomNotFoundError` for an unreadable path and
 * `UnsupportedRomError` for a file that is not a supported ROM - both carry a
 * one-line message, not a stack trace.
 */
export function readRom(path: string): LoadedRom {
  return identify(path).rom;
}

/**
 * `load`'s two halves: `rom` is what `readRom` returns, `bare` is the same
 * without a Huffman context for callers that build one themselves.
 */
function identify(path: string): { rom: LoadedRom; bare: Omit<LoadedRom, "text"> } {
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
  const rom = new RomBuffer(bytes);
  const identity = detectVersion(rom);

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

  // The checks above narrowed `version`, which is why the returned identity's
  // `version` is not nullable.
  const narrowed: RomIdentity & { version: GameVersion } = { ...identity, version: identity.version };
  const bare = { path, rom, identity: narrowed, layout };
  return { rom: { ...bare, text: makeTextContext(rom, layout.text) }, bare };
}

/**
 * Read the ROM file and read every table the extractor persists - the whole
 * pipeline `extract` runs. `options.warn` also carries the "config/data is
 * missing" warning, so a caller that wants silence passes a no-op.
 */
export function load(path: string, options: LoadOptions = {}): ParsedRom {
  const { rom: loaded, bare } = identify(path);
  const language = options.language;
  const warn = options.warn ?? ((message: string) => console.error(`warning: ${message}`));
  if (language !== undefined && !isKnownLanguage(language)) {
    // `load` is also a library entry point, so it cannot assume the CLI
    // validated `--lang` first. Same predicate as the CLI raises on - see
    // `isKnownLanguage`; only the response differs (warn, not exit 2).
    warn(`unknown --lang "${language}"; falling back to the default language`);
    return parse(bare, loaded.text, { ...options, language: DEFAULT_LANGUAGE });
  }
  return parse(bare, loaded.text, options);
}

/**
 * A loaded ROM plus every table the extractor persists - the ~650 ms a full
 * parse costs on a 30 MB hack. This is what `extract` walks into the db.
 */
export interface ParsedRom extends LoadedRom {
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
  /** Decoded once; story order, persistence and census consume this evidence. */
  eventTrace: EventTrace;
  /** Missing chapter inputs must not be mistaken for a game with no chapters. */
  chaptersAvailable: boolean;
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
 * Read every table the extractor persists, over a buffer that has already been
 * identified. Statement order carries the dependencies: units need class bases
 * (stats are signed deltas on them), shops need items (entries are priced
 * through them), shops and chapters need the object walk.
 */
function parse(
  base: Omit<LoadedRom, "text">,
  text: TextContext,
  options: LoadOptions,
): ParsedRom {
  const { path, rom: buffer, identity, layout } = base;
  const game = titleFragment(identity.version);
  const warn = options.warn ?? ((message: string) => console.error(`warning: ${message}`));
  const language = options.language;

  // Labels are optional; canonical event definitions are required to interpret
  // chapter slots and scripts. Missing inputs remain explicit in the extract.
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

  const classFlagDefs = loadClassFlags(configDir, game, language);
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
    promotedClassIds: buildPromotionGraph(classes).promoted,
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

  const chaptersAvailable = mapSettings !== null && condSlots.length > 0;
  if (!chaptersAvailable) {
    warn("chapter data unavailable: map-setting table or canonical English condition slots are missing");
  }
  if (eventScripts.scripts.length === 0) {
    warn("event data unavailable: canonical English opcode definitions are missing");
  }
  const eventTrace = extractEventTrace(buffer, layout, chapters, condSlots, eventScripts);
  const eventWarning = eventDecodeWarning(eventTrace.scripts);
  if (eventWarning !== null) warn(eventWarning);
  const transitions = readAllTransitions(eventTrace, chapters);
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
    skillSystem: identity.skillSystem,
    unitCount: units.length,
    classCount: classes.length,
    text,
  });

  return {
    path,
    rom: buffer,
    identity,
    layout,
    text,
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
    eventTrace,
    chaptersAvailable,
    chapters,
    playOrder,
    forceSortie,
    items,
    shopData,
    chapterObjects,
    skills,
  };
}
