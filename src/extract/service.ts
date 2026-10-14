/**
 * Extraction service: identify the game and read every table the extractor
 * persists. Storage and terminal output belong to the callers.
 */

import { readFileSync } from "node:fs";

import { RomBuffer } from "../rom/RomBuffer.ts";
import type { RomIdentity } from "../rom/detect.ts";
import type { GameVersion } from "../model/game.ts";
import { detectVersion, MIN_ROM_SIZES } from "../rom/detect.ts";
import type { GameLayout } from "../data/layouts.ts";
import { getLayout } from "../data/layouts.ts";
import type { TextContext } from "../text/huffman.ts";
import { makeTextContext } from "../text/huffman.ts";
import { resolveTable } from "../tables/common.ts";
import { buildClassNameMap, readAllClasses } from "../tables/classes.ts";
import { buildPromotionGraph } from "../model/promotion.ts";
import { readAllUnits } from "../tables/units.ts";
import { buildUnitNameMap } from "../format.ts";
import { readSupports } from "../tables/supports.ts";
import { readAffinityNames, readSupportBonuses } from "../tables/supportBonus.ts";
import { readTerrainNames } from "../tables/terrainNames.ts";
import { DEFAULT_LANGUAGE, findConfigDataDir, isKnownLanguage } from "../config/data.ts";
import { loadClassFlags } from "../tables/classFlags.ts";
import type { EventScriptTable } from "../tables/eventScript.ts";
import { loadConditionSlots, loadEventScripts } from "../tables/eventScript.ts";
import type { MapSettingTable } from "../tables/chapters.ts";
import { describeCondSlots, readChapters, readMapSettingTable } from "../tables/chapters.ts";
import { isRealMap, readAllTransitions } from "../tables/storyPath.ts";
import { buildPlayOrder } from "../model/storyPath.ts";
import { detectDebugMaps } from "../model/debugMap.ts";
import { readForceSortie } from "../tables/forceSortie.ts";
import { readClassBranches } from "../tables/classBranch.ts";
import type { ItemReadResult } from "../model/snapshotRecords.ts";
import {
  buildItemMap,
  loadItemEffectNames,
  readItems,
  readPromotionTables,
} from "../tables/items.ts";
import { readSkills, idCardinality } from "../tables/skills.ts";
import { readShops } from "../tables/shops.ts";
import { readAllObjects } from "../tables/mapObjects.ts";
import { extractEventTrace } from "../tables/eventTrace.ts";
import { eventDecodeWarning } from "../model/events.ts";
import { buildUnitStats } from "./unitStats.ts";
import type { ExtractionSnapshot } from "../model/snapshot.ts";

/**
 * The ROM plus what `text` needs to decode it: no table walk, no
 * `config/data`. Separate from extraction because it is a different dependency set,
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
 * Read the ROM file and identify the game: every check extraction performs, minus
 * the parse. Throws `RomNotFoundError` for an unreadable path and
 * `UnsupportedRomError` for a file that is not a supported ROM - both carry a
 * one-line message, not a stack trace.
 */
export function readRom(path: string): LoadedRom {
  return identify(path).rom;
}

/**
 * Identity and decoding context: `rom` is what `readRom` returns, `bare` is the same
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
  const narrowed: RomIdentity & { version: GameVersion } = {
    ...identity,
    version: identity.version,
  };
  const bare = { path, rom, identity: narrowed, layout };
  return { rom: { ...bare, text: makeTextContext(rom, layout.text) }, bare };
}

/**
 * Build the complete snapshot without opening a database or printing warnings.
 * Diagnostics travel with the records so library consumers receive them too.
 */
export function extractData(path: string, options: ExtractOptions = {}): ExtractionSnapshot {
  const { rom: loaded, bare } = identify(path);
  const language = options.language;
  const diagnostics: string[] = [];
  if (language !== undefined && !isKnownLanguage(language)) {
    diagnostics.push(`unknown --lang "${language}"; falling back to the default language`);
    return parse(bare, loaded.text, { ...options, language: DEFAULT_LANGUAGE }, diagnostics);
  }
  return parse(bare, loaded.text, options, diagnostics);
}

export interface ExtractOptions {
  /**
   * Explicit `config/data` directory. Defaults to the vendored `data/`
   * copy (see `config/data.ts`); override only to test against an upstream tree.
   */
  configDir?: string;
  /**
   * `--lang` value for the `config/data` name tables (`en` / `ja` / `zh`).
   * Defaults to English - see `config/data.ts` for why this differs from
   * FEBuilderGBA's own order.
   */
  language?: string;
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
  options: ExtractOptions,
  diagnostics: string[],
): ExtractionSnapshot {
  const { path, rom: buffer, identity, layout } = base;
  const game = titleFragment(identity.version);
  const warn = (message: string): void => {
    diagnostics.push(message);
  };
  const language = options.language;

  // Labels are optional; canonical event definitions are required to interpret
  // chapter slots and scripts. Missing inputs remain explicit in the extract.
  const configDir = findConfigDataDir(options.configDir);
  if (configDir === null) {
    warn(
      "config/data not found - the vendored data directory is missing, so " +
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

  // The branch table is indexed by class id and one record per extracted
  // class, so it reads after the class scan and nothing else.
  const classBranch = readClassBranches(
    buffer,
    layout,
    classes.map((c) => c.id),
  );
  if (layout.classBranch !== null && classBranch === null && classes.length > 0) {
    // The game has the table (FE8); an empty `class_branches` must not read
    // as "nothing promotes" - the same stance the untranscribed warning takes.
    warn(
      `CCBranch table unreadable for ${identity.version}: the slot at ` +
        `0x${layout.classBranch.slot.toString(16)} holds no usable pointer, ` +
        "so class_branches stays empty although the game has the table",
    );
  }

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
    warn(
      "chapter data unavailable: map-setting table or canonical English condition slots are missing",
    );
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
  // Debug content is detected over the same END_EVENT evidence as the play
  // order, and read back from `meta` by the appearance-based analyses. It
  // takes no realness predicate: a copied row can fail `isRealMap` (map 60's
  // map-id byte is a stale 0) while still being the debug map.
  const debugMaps = detectDebugMaps(transitions);

  const forceSortie = readForceSortie(buffer, layout);

  // A layout the CLI has not transcribed yet is not a table the game lacks:
  // FE7U has items, promotion lists and shops - the constants are simply not
  // ported. Say so, so an empty `items` table is not read as a legal empty
  // set (the same stance the chapter/event availability warnings take).
  const untranscribed = (["item", "promotion", "shop"] as const).filter(
    (field) => layout[field] === undefined,
  );
  if (untranscribed.length > 0) {
    warn(
      `${untranscribed.join("/")} layout not transcribed for ${identity.version}; ` +
        "the related tables stay empty - the ROM has the data, the constants are not ported yet",
    );
  }

  // Items come first: shop entries are priced through them, and map objects
  // only need the chapter list. The `+30` use-effect names come from
  // `config/data`; the promotion class lists come from the ROM itself.
  const itemEffectNames =
    configDir === null ? null : loadItemEffectNames(configDir, game, language);
  const promotionTables =
    layout.promotion === undefined ? null : readPromotionTables(buffer, layout.promotion);
  const itemData: ItemReadResult | null =
    layout.item === undefined
      ? null
      : readItems(buffer, layout.item, text, itemEffectNames, promotionTables);
  const items = itemData?.items ?? [];
  const chapterObjects = readAllObjects(buffer, layout, chapters);
  const shopData =
    layout.shop === undefined || items.length === 0
      ? null
      : readShops(buffer, layout.shop, chapterObjects, buildItemMap(items));

  // Skills last: the tables are independent of everything above, and this is
  // the only reader that searches the ROM for signatures rather than
  // dereferencing a known slot.
  //
  // The per-id tables are indexed by unit **id** and class **id**, not by a
  // position in the scan, so they are read to the id cardinality and not to
  // `units.length` / `classes.length`. The two differ on this ROM: the class
  // scan stops at the first class id 0 while the class ids run to 127.
  const skills = readSkills({
    rom: buffer,
    skillSystem: identity.skillSystem,
    unitCount: idCardinality(units),
    classCount: idCardinality(classes),
    text,
  });

  return {
    metadata: {
      path,
      sizeBytes: buffer.length,
      gameCode: identity.gameCode,
      title: identity.title,
      version: identity.version,
      displayName: layout.displayName,
      isMultibyte: layout.text.isMultibyte,
      skillSystem: identity.skillSystem,
      magicSplit: identity.magicSplit,
      notes: identity.notes,
      configDir,
      configLanguage: language ?? DEFAULT_LANGUAGE,
    },
    diagnostics,
    classes,
    units,
    supports,
    supportBonuses,
    affinityNames,
    terrainNames,
    condSlots,
    eventTrace,
    chaptersAvailable,
    eventsAvailable: chaptersAvailable && eventScripts.scripts.length > 0,
    chapters,
    playOrder,
    debugMaps,
    unitStats: buildUnitStats({ units, classes, chapters, trace: eventTrace }),
    forceSortie,
    classBranch,
    items,
    shopData,
    chapterObjects,
    skills,
  };
}
