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
 * ## What makes the laziness safe
 *
 * `LoadedRom` advertises ~30 lazy fields, and they used to be installed as a
 * bare `Object.defineProperties` map: a field declared on the interface but
 * missing from that map was a `TypeError` on first read, and nothing but
 * running the command could tell you. They are now built from a single
 * **typed record** - `FieldSpecs` is `{ [K in keyof LazyRom]: ... }` - so the
 * compiler checks completeness and the return type of every builder. Order in
 * this file still carries no meaning; dependencies are expressed by reading
 * another getter off the argument.
 *
 * ## What makes the cost visible
 *
 * Each field declares a `cost` next to its builder, and every read is timed.
 * `fe-rom <command> <rom.gba> --timings` prints the fields the command pulled,
 * what each cost, and which expensive field a cheap-looking one dragged in -
 * so `rom.joins` (which pulls the whole event-script walk) is not a surprise
 * you discover by profiling. See `LoadStats` below.
 */

import { readFileSync } from "node:fs";

import { RomBuffer } from "./rom/RomBuffer.ts";
import type { RomIdentity } from "./rom/detect.ts";
import { detectVersion, MIN_ROM_SIZES } from "./rom/detect.ts";
import type { GameLayout } from "./data/layouts.ts";
import { getLayout } from "./data/layouts.ts";
import type { TextContext } from "./text/huffman.ts";
import { makeTextContext } from "./text/huffman.ts";
import type { ResolvedTable } from "./tables/common.ts";
import { resolveTable } from "./tables/common.ts";
import type { UnitClass } from "./tables/classes.ts";
import { buildClassNameMap, readAllClasses } from "./tables/classes.ts";
import type { Unit } from "./tables/units.ts";
import { buildUnitNameMap, readAllUnits } from "./tables/units.ts";
import type { SupportGraphEdge, SupportReadResult } from "./tables/supports.ts";
import { buildSupportGraph, readSupports } from "./tables/supports.ts";
import type { SupportBonus } from "./tables/supportBonus.ts";
import { readAffinityNames, readSupportBonuses } from "./tables/supportBonus.ts";
import type { TerrainReadResult } from "./tables/terrainNames.ts";
import { readTerrainNames } from "./tables/terrainNames.ts";
import type { ClassRole } from "./tables/classRoles.ts";
import { deriveClassRoles } from "./tables/classRoles.ts";
import { findConfigDataDir, isKnownLanguage } from "./config/data.ts";
import type { ClassFlagDef } from "./tables/classFlags.ts";
import { loadClassFlags } from "./tables/classFlags.ts";
import type { EventScriptTable, CondSlot } from "./tables/eventScript.ts";
import { loadConditionSlots, loadEventScripts } from "./tables/eventScript.ts";
import type {
  Chapter,
  ChapterScan,
  CondSlotInfo,
  JoinDerivation,
  MapSettingTable,
} from "./tables/chapters.ts";
import {
  deriveJoins,
  describeCondSlots,
  readChapters,
  readMapSettingTable,
  scanChapter,
} from "./tables/chapters.ts";
import type { ChapterEdges, PlayOrder } from "./tables/storyPath.ts";
import { buildPlayOrder, isRealMap, readAllTransitions } from "./tables/storyPath.ts";
import type { ForceSortieTable } from "./tables/forceSortie.ts";
import { readForceSortie } from "./tables/forceSortie.ts";
import type { Item, ItemReadResult } from "./tables/items.ts";
import { buildItemMap, readItems } from "./tables/items.ts";
import type { ShopReadResult } from "./tables/shops.ts";
import { readShops } from "./tables/shops.ts";
import type { ChapterObjects, MapObject } from "./tables/mapObjects.ts";
import { readAllObjects } from "./tables/mapObjects.ts";

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

/** Fields computed on load. Cheap by construction - nothing here walks a table. */
export type EagerRom = Pick<LoadedRom, "path" | "rom" | "identity" | "layout" | "text">;

/** Fields installed as memoised getters. One builder each - see `FieldSpecs`. */
export type LazyRom = Omit<LoadedRom, keyof EagerRom>;

/**
 * Rough cost of computing a field, declared next to its builder.
 *
 * The point is not precision but that "which fields are expensive" is a
 * checked fact in the source rather than a sentence in a docstring:
 *
 *   - `cheap`    - under ~5 ms; safe to read from anywhere.
 *   - `moderate` - tens of ms; fine once per command, bad inside a loop.
 *   - `expensive`- hundreds of ms; reading it should be a deliberate choice.
 *
 * `--timings` prints the measured number alongside this label, so a label that
 * has drifted from reality shows up instead of quietly misleading.
 */
export type FieldCost = "cheap" | "moderate" | "expensive";

interface FieldSpec<T> {
  readonly cost: FieldCost;
  /** `rom` is the half-built `LoadedRom`; reading another field builds it. */
  readonly build: (rom: LoadedRom) => T;
}

/**
 * Every lazy field, with its declared cost and its builder.
 *
 * Mapped over `LazyRom` rather than written as a bare object literal, so a
 * field added to `LoadedRom` without a builder here - or a builder returning
 * the wrong type - fails `tsc` instead of failing at runtime on first read.
 */
type FieldSpecs = { readonly [K in keyof LazyRom]-?: FieldSpec<LazyRom[K]> };

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

/**
 * What a load actually cost, and which field pulled which.
 *
 * Kept out of `LoadedRom` on purpose - it is diagnostics, not data - and
 * reached through a `WeakMap` so nothing else about the shape changes.
 * `formatLoadTrace` turns it into the `--timings` report.
 */
export class LoadStats {
  private readonly ownMs = new Map<string, number>();
  private readonly edges = new Map<string, Set<string>>();
  private readonly roots = new Set<string>();
  private readonly costs = new Map<string, FieldCost>();
  /** Fields currently being computed, innermost last. */
  private readonly stack: string[] = [];

  declareCost(key: string, cost: FieldCost): void {
    this.costs.set(key, cost);
  }

  /** A field was read. Attribute it to whatever is being computed, or to the caller. */
  noteRead(key: string): void {
    const parent = this.stack[this.stack.length - 1];
    if (parent === undefined) {
      this.roots.add(key);
      return;
    }
    if (parent === key) return;
    const set = this.edges.get(parent);
    if (set === undefined) this.edges.set(parent, new Set([key]));
    else set.add(key);
  }

  /** Wrap one computation, timing it and recording the edges it produced. */
  measure<T>(key: string, compute: () => T): T {
    this.stack.push(key);
    const started = performance.now();
    try {
      return compute();
    } finally {
      this.stack.pop();
      this.ownMs.set(key, performance.now() - started);
    }
  }

  /** Fields read directly by the command, in first-read order. */
  rootsRead(): readonly string[] {
    return [...this.roots];
  }

  private ownMsOf(key: string): number {
    return this.ownMs.get(key) ?? 0;
  }

  /** Fields `key` read while it was being computed. */
  depsOf(key: string): readonly string[] {
    return [...(this.edges.get(key) ?? [])];
  }

  /**
   * A field's own time plus everything it pulled in. Cycles cannot happen -
   * a getter is either already done or not on the stack - but the visited set
   * keeps it true even if one is ever introduced.
   */
  totalMs(key: string, seen = new Set<string>()): number {
    if (seen.has(key)) return 0;
    seen.add(key);
    let total = this.ownMsOf(key);
    for (const dep of this.depsOf(key)) total += this.totalMs(dep, seen);
    return total;
  }

  /**
   * Time spent computing everything the command pulled in, counting each
   * field once no matter how many others read it. Summing the per-root totals
   * would charge a shared dependency once per reader.
   */
  spentMs(): number {
    const seen = new Set<string>();
    let total = 0;
    for (const root of this.roots) {
      for (const key of this.reachable(root, seen)) total += this.ownMsOf(key);
    }
    return total;
  }

  private reachable(key: string, seen: Set<string>): string[] {
    if (seen.has(key)) return [];
    seen.add(key);
    return [key, ...this.depsOf(key).flatMap((dep) => this.reachable(dep, seen))];
  }

  costOf(key: string): FieldCost | undefined {
    return this.costs.get(key);
  }
}

const STATS = new WeakMap<LoadedRom, LoadStats>();

/**
 * The timings and dependency edges observed for a loaded ROM, or `undefined`
 * for an object that did not come from `loadRom`.
 */
export function loadStatsFor(rom: LoadedRom): LoadStats | undefined {
  return STATS.get(rom);
}

const MS_WIDTH = 8;

/**
 * The `--timings` report: what the command read, what it cost, and which
 * expensive field a cheap-looking one dragged in behind it.
 */
export function formatLoadTrace(stats: LoadStats): string {
  const roots = stats.rootsRead();
  if (roots.length === 0) return "timings: no lazy table was read";

  const ms = (value: number): string => `${value.toFixed(1)}ms`.padStart(MS_WIDTH);
  const rows = roots
    .map((key) => ({ key, total: stats.totalMs(key) }))
    // Slowest first: the thing worth fixing is the thing at the top.
    .sort((a, b) => b.total - a.total);

  /** A declared `cheap` that measures this slow means the declaration is wrong
   *  about the field itself or - far more often - about what it drags in. */
  const SLOW_MS = 100;
  const tag = (key: string, total: number): string => {
    const cost = stats.costOf(key) ?? "cheap";
    if (cost !== "cheap") return ` [${cost}]`;
    return total >= SLOW_MS ? " [declared cheap]" : "";
  };

  const lines = ["timings: tables read by this command"];
  for (const { key, total } of rows) {
    const deps = stats
      .depsOf(key)
      .map((dep) => ({ dep, own: stats.totalMs(dep) }))
      .sort((a, b) => b.own - a.own);
    // Only the ones that matter: a 0.1 ms dependency is noise next to the
    // headline number, and a command can pull a dozen of them.
    const shown = deps.filter((d) => d.own >= 1).slice(0, 3);
    const tail =
      shown.length === 0
        ? ""
        : `  <- ${shown
            .map((d) => `${d.dep} ${d.own.toFixed(1)}ms${tag(d.dep, d.own)}`)
            .join(", ")}`;
    lines.push(`  ${ms(total)}  ${key}${tag(key, total)}${tail}`);
  }
  lines.push(`  ${ms(stats.spentMs())}  total across every table read once`);
  return lines.join("\n");
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
export function titleFragment(version: string): string {
  return version.slice(0, 3);
}

/**
 * A property that computes itself once, on first read.
 *
 * Non-enumerable on purpose - see the `LoadedRom` doc comment. Reading is
 * still the only way to get a value; you just cannot enumerate your way into
 * computing all of them. Every read is attributed to `stats`, which is what
 * makes the cost model observable rather than documented.
 */
function memo<T>(stats: LoadStats, key: string, compute: () => T): PropertyDescriptor {
  let done = false;
  let value: T;
  return {
    enumerable: false,
    configurable: true,
    get(): T {
      stats.noteRead(key);
      if (!done) {
        value = stats.measure(key, compute);
        done = true;
      }
      return value;
    },
  };
}

/**
 * Install every lazy field, from the one typed record.
 *
 * `specs` is checked against `LazyRom` at its declaration, so this loop cannot
 * be missing an entry; the `FieldSpec<unknown>` view is only because a union
 * of builder signatures is not directly callable.
 */
function installLazyFields(self: LoadedRom, specs: FieldSpecs, stats: LoadStats): void {
  for (const key of Object.keys(specs) as (keyof LazyRom)[]) {
    const spec = specs[key] as FieldSpec<unknown>;
    stats.declareCost(key, spec.cost);
    Object.defineProperty(
      self,
      key,
      memo(stats, key, () => spec.build(self)),
    );
  }
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

  // Only what every command needs, and all of it cheap: `makeTextContext` sets
  // up the Huffman tables without decoding anything.
  const text = makeTextContext(buffer, layout.text);
  const game = titleFragment(identity.version);
  const warn = options.warn ?? ((message: string) => console.error(`warning: ${message}`));
  const language = options.language;
  if (language !== undefined && !isKnownLanguage(language)) {
    // loadRom is also a library entry point, so it cannot assume the CLI
    // validated `--lang` first. Same predicate as the CLI raises on - see
    // `isKnownLanguage`; only the response differs (warn, not exit 2).
    warn(`unknown --lang "${language}"; falling back to the default language`);
  }
  // Only warn once, and only about the directory: a missing *file* for this
  // particular game is reported by whichever table turns up empty.
  let warnedNoConfig = false;
  const requireConfigDir = (rom: LoadedRom): string | null => {
    const dir = rom.configDir;
    if (dir === null && !warnedNoConfig) {
      warnedNoConfig = true;
      warn(
        "config/data not found - class ability names, the event-script opcode " +
          "table and the chapter-condition names are all unavailable, so " +
          "`chapters`, `roles` mobility and `units` availability will be empty " +
          "or fall back to heuristics. Set FEBUILDERGBA_CONFIG or pass " +
          "configDir to fix this.",
      );
    }
    return dir;
  };
  const self = { path, rom: buffer, identity, layout, text } as unknown as LoadedRom;
  const stats = new LoadStats();
  STATS.set(self, stats);

  const specs: FieldSpecs = {
    // `config/data` supplies the names of class ability bits and the opcode
    // table. Without it we can still parse, but roles lose the mounted/armour
    // distinction and the chapters lose their script walks.
    configDir: { cost: "cheap", build: () => findConfigDataDir(options.configDir) },
    configLanguage: { cost: "cheap", build: () => options.language ?? null },
    classFlagDefs: {
      cost: "cheap",
      build: (rom) => {
        const dir = requireConfigDir(rom);
        return dir === null ? [] : loadClassFlags(dir, game, language);
      },
    },

    classTable: { cost: "cheap", build: () => resolveTable(buffer, layout.unitClass) },
    classes: {
      cost: "moderate",
      build: (rom) =>
        readAllClasses({
          rom: buffer,
          table: rom.classTable,
          text,
          abilityFlagDefs: rom.classFlagDefs,
        }),
    },
    classNames: { cost: "cheap", build: (rom) => buildClassNameMap(rom.classes) },
    classRoles: { cost: "cheap", build: (rom) => deriveClassRoles(rom.classes) },

    unitTable: { cost: "cheap", build: () => resolveTable(buffer, layout.unit) },
    units: {
      cost: "moderate",
      build: (rom) => {
        // Class base stats turn a unit's per-unit deltas into the stats it
        // actually starts with (`startingStat = class base + unit base`).
        const classBases = new Map(rom.classes.map((c) => [c.id, c.bases]));
        return readAllUnits({
          rom: buffer,
          table: rom.unitTable,
          text,
          classNames: rom.classNames,
          classBases,
          promotedClassIds: promotedClassIdsOf(rom.classes),
        });
      },
    },
    unitNames: { cost: "cheap", build: (rom) => buildUnitNameMap(rom.units) },

    supports: {
      cost: "moderate",
      build: (rom) => readSupports(buffer, rom.units, rom.unitNames),
    },
    supportGraph: {
      cost: "cheap",
      build: (rom) => buildSupportGraph(rom.supports.entries, rom.unitNames),
    },
    supportBonuses: {
      cost: "cheap",
      build: () =>
        layout.support ? readSupportBonuses(buffer, layout.support.attributePointer) : [],
    },
    // Affinity names straight from the ROM's text table, via the text ids the
    // game's own `GetAffinityName` uses. Falls back per-entry to the hardcoded
    // table when a text id does not decode.
    affinityNames: { cost: "cheap", build: () => readAffinityNames(buffer, text) },

    terrainNames: {
      cost: "cheap",
      build: () => readTerrainNames(buffer, layout.terrainNames, text),
    },

    eventScripts: {
      cost: "moderate",
      build: (rom) => {
        const dir = requireConfigDir(rom);
        return dir === null ? { scripts: [], source: null } : loadEventScripts(dir, game, language);
      },
    },
    rawCondSlots: {
      cost: "cheap",
      build: (rom) => {
        const dir = requireConfigDir(rom);
        return dir === null ? [] : loadConditionSlots(dir, game, language);
      },
    },
    condSlots: { cost: "cheap", build: (rom) => describeCondSlots(rom.rawCondSlots) },

    mapSettings: { cost: "cheap", build: () => readMapSettingTable(buffer, layout) },
    chapters: {
      cost: "moderate",
      build: (rom) => {
        const settings = rom.mapSettings;
        const slots = rom.condSlots;
        return settings === null || slots.length === 0
          ? []
          : readChapters(buffer, layout, settings, slots, text);
      },
    },

    mapTransitions: {
      cost: "moderate",
      build: (rom) =>
        rom.eventScripts.scripts.length === 0
          ? []
          : readAllTransitions(buffer, rom.eventScripts, rom.chapters),
    },
    playOrder: {
      cost: "cheap",
      build: (rom) => {
        const real = new Set(rom.chapters.filter((c) => isRealMap(buffer, c)).map((c) => c.index));
        return buildPlayOrder(rom.mapTransitions, (m) => real.has(m));
      },
    },

    // The expensive one: every chapter's scripts, walked once per chapter.
    chapterScans: {
      cost: "expensive",
      build: (rom) =>
        rom.eventScripts.scripts.length === 0
          ? []
          : rom.chapters.map((c) =>
              scanChapter(buffer, rom.eventScripts, layout, c, rom.condSlots),
            ),
    },
    joins: {
      // Cheap in itself, but it reads `chapterScans`, so touching `joins`
      // costs the whole event-script walk. This is the field that makes the
      // declared cost worth checking against `--timings` rather than trusting.
      cost: "cheap",
      build: (rom) => {
        const ownClassOf = new Map<number, number>();
        for (const unit of rom.units) {
          if (unit.classId !== undefined) ownClassOf.set(unit.id, unit.classId);
        }
        const position = rom.playOrder.position;
        return deriveJoins(
          rom.chapters,
          rom.chapterScans,
          ownClassOf,
          (m) => position.get(m) ?? null,
        );
      },
    },

    forceSortie: { cost: "cheap", build: () => readForceSortie(buffer, layout) },

    // Items come first: shop entries are priced through them, and map objects
    // only need the chapter list.
    itemData: {
      cost: "moderate",
      build: () => (layout.item === null ? null : readItems(buffer, layout.item, text)),
    },
    items: { cost: "cheap", build: (rom) => rom.itemData?.items ?? [] },
    itemMap: { cost: "cheap", build: (rom) => buildItemMap(rom.items) },

    chapterObjects: {
      cost: "moderate",
      build: (rom) => readAllObjects(buffer, layout, rom.chapters),
    },
    mapObjects: { cost: "cheap", build: (rom) => rom.chapterObjects.flatMap((c) => c.objects) },
    shopData: {
      cost: "cheap",
      build: (rom) =>
        layout.shop === null || rom.items.length === 0
          ? null
          : readShops(buffer, layout.shop, rom.chapterObjects, rom.itemMap),
    },
  };

  installLazyFields(self, specs, stats);

  return self;
}
