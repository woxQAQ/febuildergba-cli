#!/usr/bin/env node
/**
 * fe-rom - GBA Fire Emblem ROM parser.
 *
 * Extracts unit, class and support data from FE6/FE7/FE8 ROMs so it can be fed
 * to an AI for analysis.
 *
 * Runs directly on Node >= 22.6 thanks to built-in TypeScript type stripping:
 *
 *     node src/index.ts dump ../../fixtures/dream-of-five.gba
 *
 * Zero runtime dependencies.
 */

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { loadRom, UnsupportedRomError } from './load.ts';
import { buildReport, isStoryTitle } from './analysis/report.ts';
import { validateRom } from './analysis/validate.ts';
import { summariseMobility, mobilityDisagreements } from './analysis/roles.ts';
import type { AsSummary, AutolevelRoutine, EnemySample } from './analysis/enemyStats.ts';
import {
  attackSpeedFirstWeapon,
  collectEnemyStats,
  summarizeAs,
} from './analysis/enemyStats.ts';
import {
  affinityLabel as affinityLabelForId,
  bonusByAffinity,
  rankedBonus,
  MAX_SIMULTANEOUS_SUPPORT_LEVELS,
  SUPPORT_BONUSES_MAX_DISTANCE,
  SUPPORT_EXP_DISTANCE,
  SUPPORT_BONUS_STATS,
} from './tables/supportBonus.ts';
import {
  SUPPORT_CONVERSATION_CAPS,
  SUPPORT_RANK_THRESHOLDS,
  supportRankPlan,
} from './tables/supports.ts';
import { terrainHint } from './tables/terrainNames.ts';
import {
  alwaysForcedUnits,
  forcedUnitsForMap,
  MAP_ANY,
  routeLabel,
} from './tables/forceSortie.ts';
import { decodeTextIdDetailed } from './text/huffman.ts';
import type { LoadedRom } from './load.ts';

/**
 * Affinity name preferring the ROM's own text table, falling back to the
 * reference's hardcoded switch. See `readAffinityNames`.
 *
 * Ids the ROM has no name for (hacks extend the table past the seven the
 * reference knows) fall back to `affinityLabel`, which carries the id - the
 * affinity is real and its bonuses apply, it just has no name to show.
 */
function affinityLabel(loaded: LoadedRom, id: number): string {
  return loaded.affinityNames.get(id) ?? affinityLabelForId(id);
}

const USAGE = `
fe-rom - parse GBA Fire Emblem ROMs

Usage:
  fe-rom <command> <rom.gba> [options]

Commands:
  info        ROM identity, resolved table addresses, quick sanity counters
  units       Unit table: stats, growth rates, weapon levels, class
  classes     Class table: bases, caps, movement, promotion targets
  roles       Team composition: weapon coverage, mobility, healers, affinities
  supports    Support relationships as a deduplicated edge list
  terrain     Terrain names by terrain id (the ids the cost tables use)
  chapters    Join order: per-chapter rosters and mid-chapter recruit sites
  items       Item table: type, stats, rank, durability, unit/buy/sell price
  shops       Shops: the prep-screen armoury and every per-map shop
  objects     Map objects: chests (and their loot), villages, doors, shops
  enemy-stats Enemy attack-speed distribution, projected from placement records
  text        Decode one or more text ids (diagnostic)
  dump        Everything in one JSON document, shaped for AI analysis
  validate    Self-consistency checks (see AGENTS.md section 6)

Options:
  --out <file>      Write JSON to a file instead of stdout
  --all             Include empty/unused table slots; (chapters) include
                    non-character join records
  --range a-b       (text) decode a contiguous id range, inclusive
  --playable-only   (units, roles, chapters) restrict to units that have
                    support data - the closest thing to a real roster this
                    parse can offer
  --hard            (enemy-stats) project hard-mode stats: the promoted
                    autolevel round is 19 levels instead of 9
  --compact         Emit compact JSON instead of pretty-printed
  --help, -h        Show this message

Examples:
  fe-rom info     fixtures/dream-of-five.gba
  fe-rom dump     fixtures/dream-of-five.gba --out report.json
  fe-rom roles    fixtures/dream-of-five.gba
  fe-rom terrain  fixtures/dream-of-five.gba
  fe-rom chapters fixtures/dream-of-five.gba
  fe-rom enemy-stats fixtures/dream-of-five.gba
  fe-rom validate fixtures/dream-of-five.gba
  fe-rom text     fixtures/dream-of-five.gba 703 704 --range 0x210-0x218
`.trim();

interface CliOptions {
  command: string;
  romPath: string;
  /** Positionals after the ROM path, e.g. text ids for the `text` command. */
  args: string[];
  out?: string;
  range?: string;
  all: boolean;
  compact: boolean;
  /** Restrict to units that carry support data (a proxy for "playable"). */
  playableOnly: boolean;
  /** Project hard-mode stats (`enemy-stats`). */
  hard: boolean;
}

function parseCliArgs(argv: string[]): CliOptions | null {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      range: { type: 'string' },
      all: { type: 'boolean', default: false },
      compact: { type: 'boolean', default: false },
      'playable-only': { type: 'boolean', default: false },
      hard: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return null;
  }

  const [command, romPath, ...rest] = positionals;
  if (!command || !romPath) {
    console.error(USAGE);
    process.exitCode = 2;
    return null;
  }

  return {
    command,
    romPath,
    args: rest,
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.range !== undefined ? { range: values.range } : {}),
    all: values.all ?? false,
    compact: values.compact ?? false,
    playableOnly: values['playable-only'] ?? false,
    hard: values.hard ?? false,
  };
}

function emit(value: unknown, options: CliOptions): void {
  const json = options.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  if (options.out) {
    writeFileSync(options.out, `${json}\n`, 'utf8');
    console.error(`Wrote ${options.out}`);
  } else {
    console.log(json);
  }
}

function cmdInfo(loaded: LoadedRom): unknown {
  const playable = loaded.units.filter((u) => !u.isEmpty);
  const classes = loaded.classes.filter((c) => !c.isEmpty);
  const named = playable.filter((u) => u.name.length > 0).length;

  return {
    rom: {
      file: loaded.path,
      sizeBytes: loaded.rom.length,
      sizeHex: `0x${loaded.rom.length.toString(16).toUpperCase()}`,
      gameCode: loaded.identity.gameCode,
      title: loaded.identity.title,
      version: loaded.layout.version,
      displayName: loaded.layout.displayName,
      isMultibyte: loaded.layout.text.isMultibyte,
      notes: loaded.identity.notes,
    },
    tables: {
      unit: {
        slot: `0x${loaded.unitTable.slotOffset.toString(16).toUpperCase()}`,
        address: `0x${loaded.unitTable.tableOffset.toString(16).toUpperCase()}`,
        recordSize: loaded.unitTable.recordSize,
        declaredCount: loaded.unitTable.maxCount,
        entriesRead: loaded.units.length,
        nonEmpty: playable.length,
      },
      class: {
        slot: `0x${loaded.classTable.slotOffset.toString(16).toUpperCase()}`,
        address: `0x${loaded.classTable.tableOffset.toString(16).toUpperCase()}`,
        recordSize: loaded.classTable.recordSize,
        entriesRead: loaded.classes.length,
        nonEmpty: classes.length,
      },
      text: {
        huffmanTreeBase: `0x${loaded.text.treeBase.toString(16).toUpperCase()}`,
        huffmanDataBase: `0x${loaded.text.treeDataBase.toString(16).toUpperCase()}`,
        textTableBase: `0x${loaded.text.textBase.toString(16).toUpperCase()}`,
        namesDecoded: `${named}/${playable.length}`,
      },
    },
    supports: {
      unitsWithSupportData: loaded.supports.entries.length,
      edges: loaded.supportGraph.length,
      unreadablePointers: loaded.supports.missing.length,
      rankThresholds: SUPPORT_RANK_THRESHOLDS,
      conversationCaps: SUPPORT_CONVERSATION_CAPS,
      affinities: Object.fromEntries(
        [...loaded.affinityNames.entries()].map(([id, name]) => [id, name]),
      ),
      bonusTable: loaded.supportBonuses.map((b) => ({
        affinity: b.affinity,
        name: affinityLabel(loaded, b.affinity),
        storedHalfPoints: Object.fromEntries(
          SUPPORT_BONUS_STATS.map((s) => [s, b.bonuses[s]]),
        ),
        byRank: rankedBonus(b),
      })),
    },
    terrainNames: {
      table: loaded.terrainNames.table?.tableOffset ?? null,
      recordSize: loaded.terrainNames.table?.recordSize ?? null,
      count: loaded.terrainNames.names.length,
      decoded: loaded.terrainNames.names.filter((n) => n.decoded).length,
    },
  };
}

function cmdUnits(loaded: LoadedRom, options: CliOptions): unknown {
  const supportUnitIds = new Set(loaded.supports.entries.map((e) => e.unitId));
  let units = options.all ? loaded.units : loaded.units.filter((u) => !u.isEmpty);
  if (options.playableOnly) units = units.filter((u) => supportUnitIds.has(u.id));
  return units.map((u) => {
    const role = loaded.classRoles.get(u.classId);
    return {
      id: u.id,
      name: u.name,
      /**
       * The decoded name with `@XXXX` text escapes left in. Differs from `name`
       * only where the ROM put a glyph code inside the name field.
       */
      nameRaw: u.nameRaw,
      className: u.className,
      classId: u.classId,
      level: u.level,
      /** Per-unit deltas, signed - NOT the stats the unit starts with. */
      stats: u.stats,
      /** `class base + stats`: what the unit actually starts with. Compare with this. */
      startingStats: u.startingStats,
      growths: u.growths,
      growthTotal: u.growthTotal,
      weaponLevels: u.weaponLevels,
      affinity: u.attribute === 0 ? null : affinityLabel(loaded, u.attribute),
      /**
       * Raw affinity id, kept alongside the name because ids past the
       * reference's seven have no name to show - `"-"` alone would leave the
       * reader unable to tell which of several unnamed affinities this is.
       */
      affinityId: u.attribute === 0 ? null : u.attribute,
      mobility: role?.mobility ?? null,
      hasStaff: role?.hasStaff ?? null,
      supportAddress: u.hasSupportData ? `0x${u.supportAddress.toString(16).toUpperCase()}` : null,
    };
  });
}

function cmdClasses(loaded: LoadedRom, options: CliOptions): unknown {
  const classes = options.all ? loaded.classes : loaded.classes.filter((c) => !c.isEmpty);
  const terrainName = new Map(loaded.terrainNames.names.map((n) => [n.id, n.name]));
  const isMultibyte = loaded.terrainNames.table?.isMultibyte ?? false;
  // Ids 0x00, 0x2C and 0x2E have no name in this ROM, so fall back to hex
  // rather than emitting an empty label. For those, append the reference's own
  // hint if it has one - 0x2E is "fliers may pass", which is the whole reason a
  // ground class lists it as impassable.
  const label = (id: number): string => {
    const name = terrainName.get(id);
    if (name !== undefined && name !== '') return name;
    const hint = terrainHint(id, isMultibyte);
    return `terrain 0x${id.toString(16)}${hint === '' ? '' : ` ${hint}`}`;
  };

  return classes.map((c) => ({
    id: c.id,
    name: c.name,
    movement: c.movementRange,
    promotesToClassId: c.promotesToClassId,
    promotesTo:
      c.promotesToClassId === 0
        ? null
        : (loaded.classNames.get(c.promotesToClassId) ?? `class ${c.promotesToClassId}`),
    bases: c.bases,
    caps: c.caps,
    promotionBonuses: c.promotionBonuses,
    weaponLevels: c.weaponLevels,
    /**
     * Terrain this class cannot enter at all (`cost == 0xFF`), named from the
     * terrain-name table - the cost columns and the name ids are the same
     * index space (see `tables/terrainNames.ts`). A flier's list is short.
     */
    impassableTerrains: c.movementCosts
      .map((cost, id) => (cost === 0xff ? label(id) : null))
      .filter((n): n is string => n !== null),
  }));
}

/**
 * Team-composition view: what the roster can actually field.
 *
 * Mobility comes from the class ability flags (`config/data/unitclass_checkbox_*`),
 * with the terrain-cost table as a fallback and cross-check. See
 * `analysis/roles.ts`.
 */
function cmdRoles(loaded: LoadedRom, options: CliOptions): unknown {
  const supportUnitIds = new Set(loaded.supports.entries.map((e) => e.unitId));
  const playable = loaded.units.filter(
    (u) => !u.isEmpty && (!options.playableOnly || supportUnitIds.has(u.id)),
  );

  // Which playable units can use each weapon type.
  const byWeapon = new Map<string, { id: number; name: string; className: string }[]>();
  const affinityCounts = new Map<string, number>();
  const mobilityCounts = new Map<string, number>();
  let withStaff = 0;
  let magicUsers = 0;

  for (const unit of playable) {
    const role = loaded.classRoles.get(unit.classId);
    if (unit.attribute !== 0) {
      const name = affinityLabel(loaded, unit.attribute);
      affinityCounts.set(name, (affinityCounts.get(name) ?? 0) + 1);
    }
    if (!role) continue;
    if (role.hasStaff) withStaff++;
    if (role.isMagic) magicUsers++;
    mobilityCounts.set(role.mobility, (mobilityCounts.get(role.mobility) ?? 0) + 1);
    for (const weapon of role.weapons) {
      const list = byWeapon.get(weapon) ?? [];
      list.push({ id: unit.id, name: unit.name, className: unit.className });
      byWeapon.set(weapon, list);
    }
  }

  const allRoles = [...loaded.classRoles.values()];

  return {
    roster: {
      /**
       * Every populated unit slot - NOT the player roster. Enemies, bosses and
       * generic templates ("Priest", "Outlaw") are in here too. Use
       * `withSupportData` as a rough proxy for "actually playable", or the
       * `chapters` command for join order.
       */
      populatedUnitSlots: playable.length,
      withSupportData: supportUnitIds.size,
      filteredToPlayableOnly: options.playableOnly,
      classesInUse: new Set(playable.map((u) => u.classId)).size,
      note:
        'populatedUnitSlots counts every non-empty record, including enemies ' +
        'and generic templates. Use --playable-only to narrow to units that ' +
        'carry support data.',
    },
    coverage: {
      weaponTypes: Object.fromEntries(
        [...byWeapon.entries()]
          .sort((x, y) => y[1].length - x[1].length)
          .map(([weapon, users]) => [weapon, users]),
      ),
      healers: {
        count: withStaff,
        units: playable
          .filter((u) => loaded.classRoles.get(u.classId)?.hasStaff)
          .map((u) => ({ id: u.id, name: u.name, className: u.className })),
      },
      magicUsers: {
        count: magicUsers,
        units: playable
          .filter((u) => loaded.classRoles.get(u.classId)?.isMagic)
          .map((u) => ({ id: u.id, name: u.name, className: u.className })),
      },
      mobility: {
        ...Object.fromEntries(mobilityCounts),
        note:
          'Labels come from the class ability flags when the ROM sets them ' +
          '(check `mobilitySource` per class); otherwise they are inferred ' +
          'from the terrain movement-cost table.',
      },
      specialActionClasses: allRoles
        .filter((r) => r.specialAction !== null)
        .map((r) => ({ classId: r.classId, className: r.className, role: r.specialAction })),
    },
    affinities: Object.fromEntries(
      [...affinityCounts.entries()].sort((x, y) => y[1] - x[1]),
    ),
    classRoles: allRoles
      .sort((x, y) => x.classId - y.classId)
      .map((r) => ({
        classId: r.classId,
        className: r.className,
        mobility: r.mobility,
        mobilitySource: r.mobilitySource,
        mount: r.mount,
        specialAction: r.specialAction,
        movement: r.movement,
        weapons: r.weapons,
        hasStaff: r.hasStaff,
        isMagic: r.isMagic,
        abilityFlags: r.flags,
      })),
    classMobilitySummary: summariseMobility(loaded.classRoles),
    mobilityDisagreements: mobilityDisagreements(loaded.classRoles),
    flagSource:
      loaded.configDir === null
        ? 'config/data NOT found - mobility is inferred from terrain costs only'
        : loaded.configDir,
  };
}

/**
 * Join order. A unit's join chapter is not stored anywhere; it is derived from
 * two kinds of evidence:
 *
 *   1. the chapter's initial player placement block (condition slot 10), and
 *   2. `LOAD1` ("自軍ユニットは仲間にする") instructions in the chapter's events.
 *
 * See `tables/chapters.ts` for the full chain and its two documented
 * deviations from FEBuilderGBA.
 */
function cmdChapters(loaded: LoadedRom, options: CliOptions): unknown {
  const supportIds = new Set(loaded.supports.entries.map((e) => e.unitId));
  const unitById = new Map(loaded.units.map((u) => [u.id, u]));

  const describe = (id: number): string => {
    const unit = unitById.get(id);
    if (unit === undefined || unit.name.length === 0) return `#${id}`;
    return unit.name;
  };

  interface UnitRef {
    id: number;
    name: string;
    ownClassId: number | null;
    ownClassName: string | null;
    isSupportCharacter: boolean;
  }

  const described = (id: number): UnitRef => {
    const unit = unitById.get(id);
    return {
      id,
      name: describe(id),
      ownClassId: unit?.classId ?? null,
      ownClassName: unit?.className ?? null,
      isSupportCharacter: supportIds.has(id),
    };
  };

  const chapters = loaded.chapters.map((chapter) => {
    const scan = loaded.chapterScans.find((s) => s.chapterIndex === chapter.index);
    return {
      mapIndex: chapter.index,
      /**
       * The game's own chapter number (`u16(record + 0x80) / 2`). **Use this,
       * not `mapIndex`.** The table has a row per map id, so `mapIndex` counts
       * unused slots and bonus maps too; 0 means "this row is not a chapter".
       */
      chapterNumber: chapter.chapterNumber,
      /** Chapter title from `+0x70`; `''` for unused slots, `@001F` for world-map maps. */
      title: chapter.title,
      titleTextId: chapter.titleTextId,
      mapSettingAddress: `0x${chapter.mapSettingAddr.toString(16).toUpperCase()}`,
      eventPlist: chapter.eventPlist,
      condTableAddress:
        chapter.condTableAddr === 0
          ? null
          : `0x${chapter.condTableAddr.toString(16).toUpperCase()}`,
      startEvent:
        chapter.startEventAddr === 0
          ? null
          : `0x${chapter.startEventAddr.toString(16).toUpperCase()}`,
      endEvent:
        chapter.endEventAddr === 0 ? null : `0x${chapter.endEventAddr.toString(16).toUpperCase()}`,
      playerPlacement:
        chapter.playerPlacementAddr === 0
          ? null
          : `0x${chapter.playerPlacementAddr.toString(16).toUpperCase()}`,
      /**
       * How many units this map lets you field. See `Chapter.deploySlots` in
       * `tables/chapters.ts` for how this is derived and why it is the same
       * number the game computes in `GetChapterAllyUnitCount`.
       */
      deploySlots: chapter.deploySlots,
      /** Same, on hard mode (condition slot 11). Falls back to `deploySlots`. */
      deploySlotsHard: chapter.deploySlotsHard,
      /**
       * Units the prep screen will not let you bench here
       * (`event_force_sortie_pointer`). A record's `mapIndex` of 0xFF means
       * "every map", so such units also appear on every chapter's list.
       */
      forcedUnits: forcedUnitsForMap(loaded.forceSortie, chapter.index).map((f) => ({
        ...described(f.unitId),
        /** 0xFF = applies on every route; otherwise `ChapterData + 0x1B`. */
        routeFilter: f.route,
        routeFilterLabel: routeLabel(f.route),
        /** True when the record has no map filter - the unit is forced everywhere. */
        everyMap: f.mapIndex === MAP_ANY,
        recordAddress: `0x${f.addr.toString(16).toUpperCase()}`,
      })),
      placements: chapter.placements.map((p) => {
        const ref = described(p.unitId);
        return {
          ...ref,
          placedClassId: p.classId,
          placedClassName:
            p.classId === 0 ? '(own class)' : (loaded.classNames.get(p.classId) ?? null),
          level: p.level,
          prePlacementCoord: p.prePlacementCoord,
          postPlacementCoords: p.postPlacementCount,
          classOverridden: p.classId !== 0 && p.classId !== ref.ownClassId,
        };
      }),
      recruitSites: (scan?.recruits ?? []).map((site) => ({
        kind: site.kind,
        slot: site.slotKind,
        address: `0x${site.addr.toString(16).toUpperCase()}`,
        instruction: site.instruction,
        block: `0x${site.blockAddr.toString(16).toUpperCase()}`,
        units: site.units.map((u) => ({
          id: u.unitId,
          name: describe(u.unitId),
          placedClassId: u.classId,
        })),
      })),
      truncatedScriptWalks: scan?.truncatedWalks ?? 0,
      /**
       * Direct gold writes reachable from this chapter's scripts, from the two
       * literal instructions `40050300XXXX000021370000` (gain) and
       * `...22370000` (lose). Money bags handed over as items are in
       * `itemsGiven`, not here.
       */
      goldEvents: (scan?.gold ?? []).map((g) => ({
        address: `0x${g.addr.toString(16).toUpperCase()}`,
        delta: g.delta,
        instruction: g.instruction,
      })),
      /**
       * Items this chapter's scripts hand out. `unitPrice` is the item's `+26`
       * field: for a money bag (`Gold`, `3,000 Gold`, ...) that field **is** the
       * gold amount the bag is worth, which is how the game pays out money.
       */
      itemsGiven: (scan?.itemsGiven ?? []).map((g) => {
        const item = loaded.itemMap.get(g.itemId);
        return {
          address: `0x${g.addr.toString(16).toUpperCase()}`,
          itemId: g.itemId,
          name: item?.name ?? `item#${g.itemId}`,
          unitPrice: item?.unitPrice ?? 0,
          toUnit: g.unitId === 0xffff ? '(visiting unit)' : describe(g.unitId),
        };
      }),
    };
  });

  const rows: Array<Record<string, unknown>> = [];
  const chapterOf = (index: number | null | undefined) =>
    index === null || index === undefined
      ? null
      : (loaded.chapters.find((c) => c.index === index) ?? null);
  const titleOf = (index: number | null | undefined): string | null =>
    chapterOf(index)?.title ?? null;
  const where = (index: number | null | undefined): string => {
    const chapter = chapterOf(index);
    if (chapter === null) return `map#${index}`;
    const label = chapter.title === '' ? '(untitled)' : chapter.title;
    return chapter.chapterNumber > 0
      ? `ch${chapter.chapterNumber} ${label}`
      : `map#${index} ${label}`;
  };
  const unitIds = new Set<number>([...loaded.joins.joins.keys(), ...loaded.joins.appearances.keys()]);
  for (const record of loaded.forceSortie?.records ?? []) unitIds.add(record.unitId);

  // unit id -> the forced-deployment records that name it, with the chapter they
  // apply to resolved. A record with mapIndex 0xFF applies everywhere.
  const forcedByUnit = new Map<number, Array<{ chapterIndex: number | null; route: number; everyMap: boolean }>>();
  for (const record of loaded.forceSortie?.records ?? []) {
    const list = forcedByUnit.get(record.unitId) ?? [];
    list.push({
      chapterIndex: record.mapIndex === MAP_ANY ? null : record.mapIndex,
      route: record.route,
      everyMap: record.mapIndex === MAP_ANY,
    });
    forcedByUnit.set(record.unitId, list);
  }

  for (const id of unitIds) {
    if (!options.all && !supportIds.has(id)) continue;
    if (options.playableOnly && !supportIds.has(id)) continue;
    const join = loaded.joins.joins.get(id);
    const appearance = loaded.joins.appearances.get(id);
    const earliestChapter = appearance?.chapterIndex ?? join?.chapterIndex ?? null;
    const earliestSource = appearance?.source ?? join?.source ?? null;
    const joinRecord = chapterOf(join?.chapterIndex);
    const joinIsStory = joinRecord === null ? null : isStoryTitle(joinRecord.title);
    const forced = forcedByUnit.get(id) ?? [];
    const forcedEverywhere = forced.filter((f) => f.everyMap);
    const notes: string[] = [];
    if (forced.length > 0) {
      const places = forcedEverywhere.length > 0
        ? 'on every map'
        : forced
            .map((f) => (f.chapterIndex === null ? 'every map' : where(f.chapterIndex)))
            .join(', ');
      notes.push(`forced deployment: must be fielded ${places}.`);
    }
    if (join === undefined) {
      notes.push(
        earliestChapter === null
          ? 'no chapter evidence found at all'
          : `no recruit instruction names this unit; it is only loaded ` +
            `(${earliestSource}) in ${where(earliestChapter)}.`,
      );
    } else if (earliestChapter !== null && earliestChapter < join.chapterIndex) {
      notes.push(
        `loaded (${earliestSource}) in ${where(earliestChapter)} but only ` +
          `recruited in ${where(join.chapterIndex)}; the real join is likely ` +
          `${where(earliestChapter)} or earlier.`,
      );
    }
    if (joinIsStory === false) {
      notes.push(
        `the recruit instruction points at map#${join?.chapterIndex}, which has ` +
          'no title (an unused slot or a world-map encounter map) - treat this ' +
          'join chapter as unreliable.',
      );
    }
    rows.push({
      ...described(id),
      /** Earliest chapter with a placement or a `LOAD1` ("仲間にする") instruction. */
      joinChapter: join?.chapterIndex ?? null,
      /** The game's chapter number for `joinChapter`. **Prefer this over `joinChapter`.** */
      joinChapterNumber: joinRecord?.chapterNumber ?? null,
      /** **Prefer this over `joinChapter`** - the index counts placeholder records. */
      joinChapterTitle: joinRecord?.title ?? null,
      /** False when `joinChapter` is an unused slot, a skirmish map or a bonus map. */
      joinChapterIsStory: joinIsStory,
      joinSource: join?.source ?? null,
      joinEvidence: join === undefined ? null : `0x${join.evidenceAddr.toString(16).toUpperCase()}`,
      placedClassId: join?.placedClassId ?? null,
      /**
       * Chapters where the prep screen will not let this unit be benched
       * (`event_force_sortie_pointer`). An entry with `mapIndex: null` has no
       * map filter and therefore applies to every map. `[]` means the unit is
       * never force-deployed by this table - note the game may still force the
       * lord through a separate rule, so `[]` is not "freely benchable".
       */
      forcedDeployment: forced.map((f) => ({
        mapIndex: f.chapterIndex,
        chapterNumber:
          f.chapterIndex === null ? null : (chapterOf(f.chapterIndex)?.chapterNumber ?? null),
        chapterTitle: f.chapterIndex === null ? null : (chapterOf(f.chapterIndex)?.title ?? null),
        everyMap: f.everyMap,
        routeFilter: f.route,
        routeFilterLabel: routeLabel(f.route),
      })),
      /**
       * Earliest chapter with *any* load evidence, including `LOAD2`. A `LOAD2`
       * only loads units that are already in the party, so this is a sound
       * lower bound on "usable from" - but it can also be a script the author
       * reused defensively, so it is a hint rather than a fact.
       */
      earliestEvidenceChapter: earliestChapter,
      earliestEvidenceChapterNumber: chapterOf(earliestChapter)?.chapterNumber ?? null,
      earliestEvidenceChapterTitle: titleOf(earliestChapter),
      earliestEvidenceSource: earliestSource,
      ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
    });
  }
  rows.sort(
    (a, b) =>
      ((a.joinChapter as number | null) ?? Number.MAX_SAFE_INTEGER) -
        ((b.joinChapter as number | null) ?? Number.MAX_SAFE_INTEGER) ||
      (a.id as number) - (b.id as number),
  );

  return {
    source: {
      configDir: loaded.configDir,
      eventOpcodeTable: loaded.eventScripts.source,
      eventOpcodes: loaded.eventScripts.scripts.length,
    },
    mapSettings:
      loaded.mapSettings === null
        ? null
        : {
            slot: `0x${loaded.mapSettings.slotOffset.toString(16).toUpperCase()}`,
            table: `0x${loaded.mapSettings.tableOffset.toString(16).toUpperCase()}`,
            recordSize: loaded.mapSettings.recordSize,
            count: loaded.mapSettings.count,
            countSource: loaded.mapSettings.countSource,
            countNote:
              loaded.mapSettings.countSource === 'structural'
                ? 'The reference terminator test (u32(+0) must not be a pointer) ' +
                  'rejected every record, so the table was scanned on structure.'
                : 'Counted with the reference terminator test.',
          },
    conditionSlots: loaded.condSlots.map((s) => ({
      index: s.index,
      flag: s.flag,
      kind: s.kind,
      name: s.name,
    })),
    forcedDeployment: {
      table:
        loaded.forceSortie === null
          ? null
          : {
              slot: `0x${loaded.forceSortie.slotOffset.toString(16).toUpperCase()}`,
              address: `0x${loaded.forceSortie.tableOffset.toString(16).toUpperCase()}`,
              recordSize: loaded.forceSortie.recordSize,
              count: loaded.forceSortie.count,
              termination: loaded.forceSortie.termination,
            },
      /**
       * Records with no map filter (`mapIndex` 0xFF): these units are forced on
       * every map, which is what a "must always be deployed" lord looks like.
       */
      everyMap: alwaysForcedUnits(loaded.forceSortie).map((f) => ({
        ...described(f.unitId),
        routeFilter: f.route,
        routeFilterLabel: routeLabel(f.route),
      })),
      /** Every record, including the per-map ones. */
      records: (loaded.forceSortie?.records ?? []).map((f) => ({
        ...described(f.unitId),
        mapIndex: f.mapIndex,
        mapIndexIsAny: f.mapIndex === MAP_ANY,
        chapterNumber:
          f.mapIndex === MAP_ANY ? null : (chapterOf(f.mapIndex)?.chapterNumber ?? null),
        chapterTitle: f.mapIndex === MAP_ANY ? null : (chapterOf(f.mapIndex)?.title ?? null),
        routeFilter: f.route,
        routeFilterLabel: routeLabel(f.route),
        recordAddress: `0x${f.addr.toString(16).toUpperCase()}`,
      })),
      limitations: [
        'The route byte is compared by the game against a RUNTIME value ' +
          '(ChapterData + 0x1B), so it cannot be resolved statically. Records ' +
          'are reported regardless of it; check routeFilter when it is not 0xFF.',
        'A unit absent from this table is not necessarily benchable - the lord ' +
          'is force-deployed by a separate rule the table does not describe.',
        'A record with mapIndex 0xFF applies to every map, so such units appear ' +
          'on every chapter\'s forcedUnits list.',
      ],
    },
    stats: {
      /** Rows in the map-setting table, not the number of story chapters. */
      mapSettingRecords: loaded.chapters.length,
      /** Rows that carry a non-zero chapter number (`+0x80 / 2`). */
      chaptersWithNumber: loaded.chapters.filter((c) => c.chapterNumber > 0).length,
      /** Highest chapter number in the table. */
      maxChapterNumber: loaded.chapters.reduce((n, c) => Math.max(n, c.chapterNumber), 0),
      placementsExamined: loaded.joins.placementsExamined,
      classOverriddenPlacements: loaded.joins.classOverriddenPlacements,
      loadSites: loaded.joins.sitesByKind,
      unitsWithJoinEvidence: loaded.joins.joins.size,
      unitsWithAnyAppearance: loaded.joins.appearances.size,
      /** Forced-deployment records read (0 when the game has no such table). */
      forceSortieRecords: loaded.forceSortie?.count ?? 0,
      /** Units named by the forced-deployment table. */
      unitsForcedSomewhere: new Set((loaded.forceSortie?.records ?? []).map((r) => r.unitId)).size,
      /** Highest deployment slot count across all maps. */
      maxDeploySlots: loaded.chapters.reduce((n, c) => Math.max(n, c.deploySlots), 0),
    },
    joinOrder: rows,
    chapters,
    limitations: [
      'A placement record counts as the named character only when its class id ' +
        'is 0 or matches the unit\'s own class. Hack authors reuse one unit id ' +
        'as a generic template with varying class ids; those records are ' +
        'reported with classOverridden=true and excluded from join order.',
      'mapIndex is a row number in the map-setting table, NOT a chapter ' +
        'number: the table has one row per map id, so it also holds unused ' +
        'slots (chapterNumber 0), world-map/skirmish maps (title "@001F", ' +
        'sharing a story chapter\'s number) and bonus maps. Use ' +
        'chapterNumber / joinChapterNumber, or the decoded title.',
      'Script walks stop after ten consecutive unrecognised opcodes, matching ' +
        'FEBuilderGBA. truncatedScriptWalks counts those. A recruit site after ' +
        'such a stop is missed.',
      'LOAD2 (412C) and LOAD3 (422C) do not recruit; they appear in ' +
        'earliestEvidenceChapter only. A LOAD2 loads units that are already in ' +
        'the party, so when it predates the joinChapter the real join is ' +
        'probably earlier - such rows carry a `note`.',
      'Hack chapters often share one "load the whole party" script between ' +
        'several maps, so a LOAD1 seen in a late chapter is usually a re-load, ' +
        'not a join.',
      'Deduplication is **per chapter**, never across chapters. One script can ' +
        'be referenced by many maps, so the same goldEvents / itemsGiven ' +
        '`address` (and the same placement block) reappears under every chapter ' +
        'that reaches it. Deduplicate by address before summing: a single ' +
        '5,000-gold script shared by 17 maps is one payout, not 85,000 gold.',
    ],
  };
}

function cmdSupports(loaded: LoadedRom): unknown {
  return {
    limit: 7,
    /**
     * Cumulative support points that define each rank. A pair holds one of
     * these values *after* taking the corresponding support conversation.
     */
    rankThresholds: SUPPORT_RANK_THRESHOLDS,
    /**
     * The point totals at which each rank's support conversation unlocks - one
     * below the rank's own threshold, because `UnitGainSupportExp` clamps the
     * pair's total to the cap for its current rank.
     */
    conversationCaps: SUPPORT_CONVERSATION_CAPS,
    /**
     * How far the bonuses reach versus how close the pair must be to gain
     * points. `bonusRange` is Chebyshev-free: both are Manhattan (|dx| + |dy|).
     */
    distances: {
      bonusRange: SUPPORT_BONUSES_MAX_DISTANCE,
      expRange: SUPPORT_EXP_DISTANCE,
    },
    /** Support *levels* a single unit may hold in total (A=3, B=2, C=1). */
    maxTotalSupportLevels: MAX_SIMULTANEOUS_SUPPORT_LEVELS,
    edges: loaded.supportGraph.map((e) => ({
      a: e.a,
      aName: e.aName,
      b: e.b,
      bName: e.bName,
      initial: e.initial,
      growth: e.growth,
      ...supportRankPlan(e.initial, e.growth),
      reciprocal: e.reciprocal,
      ...(e.mismatch ? { mismatch: e.mismatch } : {}),
    })),
    byUnit: loaded.supports.entries.map((entry) => ({
      id: entry.unitId,
      name: entry.unitName,
      declaredCount: entry.declaredCount,
      partners: entry.partners.map((p) => ({
        id: p.unitId,
        name: p.unitName,
        initial: p.initial,
        growth: p.growth,
        ...supportRankPlan(p.initial, p.growth),
      })),
    })),
    limitations: [
      'A support bonus is the sum of BOTH units\' affinity rows, each scaled by ' +
        'its own rank, then halved once at the end: ' +
        'floor((row[mine]*L(mine) + row[theirs]*L(theirs)) / 2) with L = 1/2/3 ' +
        'for C/B/A. The table stores HALF-points, which is why every row shows ' +
        'atk=1 and critAvoid=5 - read the `byRank` view instead of the raw bytes.',
      'Only adjacent pairs (|dx| + |dy| <= 1, or one carrying the other) gain ' +
        'support points, but the bonus applies out to 3 tiles. The asymmetry is ' +
        'in the game code, not a parse artefact.',
      'One support level per pair per chapter, and a unit may hold at most 5 ' +
        'support levels in total (A=3, B=2, C=1).',
      'turnsTo assumes every conversation is taken the instant it unlocks and ' +
        'ignores the one-level-per-chapter cap, so it is a lower bound on the ' +
        'number of chapters needed.',
    ],
  };
}

/**
 * Terrain names. These are the same terrain ids a class's movement-cost table
 * is indexed by, so this is what turns "cost 0xFF at id 0x12" into "Peak".
 */
function cmdTerrain(loaded: LoadedRom, options: CliOptions): unknown {
  const { table, names } = loaded.terrainNames;
  const isMultibyte = table?.isMultibyte ?? loaded.layout.text.isMultibyte;

  return {
    table:
      table === null
        ? null
        : {
            slot: `0x${table.slotOffset.toString(16).toUpperCase()}`,
            address: `0x${table.tableOffset.toString(16).toUpperCase()}`,
            recordSize: table.recordSize,
            count: table.count,
            shape: isMultibyte
              ? '4-byte pointer to a raw Shift-JIS string (MapTerrainNameForm)'
              : '2-byte text id (MapTerrainNameEngForm)',
          },
    entries: (options.all ? names : names.filter((n) => n.name !== '' || n.raw.length > 0)).map(
      (n) => ({
        id: n.id,
        idHex: `0x${n.id.toString(16).toUpperCase().padStart(2, '0')}`,
        name: n.name,
        hint: terrainHint(n.id, isMultibyte) || null,
        textId: n.textId,
        nameAddress: n.nameAddress === null ? null : `0x${n.nameAddress.toString(16).toUpperCase()}`,
        decoded: n.decoded,
        ...(n.decoded ? {} : { raw: n.raw }),
      }),
    ),
    limitations: [
      'Terrain ids run 0..0x40 (65 entries) and match the movement-cost table ' +
        'column order, so a class cost table and this table share an index.',
      'Japanese releases store these as raw Shift-JIS strings with no Huffman ' +
        'layer; this CLI cannot decode Shift-JIS yet, so those entries come ' +
        'back with decoded=false and the raw bytes.',
      'A name is only a label. The mechanical properties (cost, avoid, defence, ' +
        'heal) live in the class cost table and the terrain avoid/defence/' +
        'resistance pointers, not here.',
    ],
  };
}

/**
 * `items` — the item table, with the derived price columns.
 *
 * The ROM stores a **unit price** (`+26`); the shop price is `uses x unitPrice`
 * and the sell price is half that (`ItemForm.cs:309-311`). Both are computed
 * here so nobody has to re-derive them.
 */
function cmdItems(loaded: LoadedRom, options: CliOptions): unknown {
  const table = loaded.itemData?.table ?? null;
  const items = options.all ? loaded.items : loaded.items.filter((i) => i.nameTextId !== 0);

  return {
    table:
      table === null
        ? null
        : {
            slot: `0x${table.slotOffset.toString(16).toUpperCase()}`,
            address: `0x${table.tableOffset.toString(16).toUpperCase()}`,
            recordSize: table.recordSize,
            entriesRead: table.count,
            nonEmpty: loaded.items.filter((i) => i.nameTextId !== 0).length,
          },
    priceRule: 'buyPrice = uses x unitPrice (+26); sellPrice = buyPrice / 2',
    entries: items.map((i) => ({
      id: i.id,
      idHex: `0x${i.id.toString(16).toUpperCase().padStart(2, '0')}`,
      name: i.name,
      type: i.typeName,
      rank: i.weaponRankLetter,
      /** Raw `+28` byte; a unit can equip when its own weapon level >= this. */
      rankValue: i.weaponRank,
      uses: i.uses,
      might: i.might,
      hit: i.hit,
      crit: i.crit,
      weight: i.weight,
      range: `${i.rangeMin}-${i.rangeMax}`,
      wexp: i.wexp,
      unitPrice: i.unitPrice,
      buyPrice: i.buyPrice,
      sellPrice: i.sellPrice,
      ...(i.nameUnknownCodes.length ? { unmappedNameCodes: i.nameUnknownCodes } : {}),
    })),
    limitations: [
      'Names are stored in FE8\'s item-name font, not in the normal text ' +
        'encoding; they are decoded via the empirical table in text/itemFont.ts. ' +
        'See that file for how the alphabet was recovered and which slots are ' +
        'inferred rather than observed.',
      'The type field is 0-based in this ROM (0=sword), unlike FE6/FE7.',
      'Effectiveness / stat-bonus / staff-effect are pointers or ids that this ' +
        'CLI reports verbatim; it does not resolve them to class lists or boosts.',
    ],
  };
}

/** `shops` — prep-screen shop plus every per-map shop, grouped by chapter. */
function cmdShops(loaded: LoadedRom, options: CliOptions): unknown {
  const shopData = loaded.shopData;
  if (shopData === null) {
    return { shops: [], notes: ['This game layout has no shop section.'] };
  }

  const shops = options.all ? shopData.shops : shopData.shops;

  return {
    prepShopAddress: `0x${shopData.prepShopAddress.toString(16).toUpperCase()}`,
    shopCount: shops.length,
    emptyShopPointers: shopData.emptyCount,
    shops: shops.map((s) => ({
      label: s.label,
      kind: s.kind,
      address: `0x${s.addr.toString(16).toUpperCase()}`,
      mapIndex: s.mapIndex,
      chapterNumber: s.chapterNumber,
      entries: s.entries.map((e) => ({
        itemId: e.itemId,
        name: e.name,
        uses: e.effectiveUses,
        price: e.price,
      })),
    })),
    limitations: [
      'World-map point shops (`WorldMapPointForm.GetShopAddr`: +12 weapon, ' +
        '+16 item, +20 secret) are not read; `worldmap_point_pointer` is not ' +
        'transcribed for FE8U. In this chapter-based hack the per-map scan ' +
        'finds those lists anyway.',
      'A shop entry\'s second byte is the durability it sells at; 0 means ' +
        'full, and the price is scaled accordingly.',
    ],
  };
}

function cmdEnemyStats(loaded: LoadedRom, options: CliOptions): unknown {
  const { samples, unresolvedClass } = collectEnemyStats({
    rom: loaded.rom,
    layout: loaded.layout,
    eventScripts: loaded.eventScripts,
    chapters: loaded.chapters,
    condSlots: loaded.condSlots,
    classes: loaded.classes,
    units: loaded.units,
    items: loaded.items,
    hard: options.hard,
  });

  const round = (n: number): number => Math.round(n * 100) / 100;
  const summary = (s: AsSummary) => ({
    n: s.n,
    min: round(s.min),
    p10: round(s.p10),
    p25: round(s.p25),
    median: round(s.median),
    p75: round(s.p75),
    p90: round(s.p90),
    max: round(s.max),
    mean: round(s.mean),
    /** Outer envelope of the RNG-driven band across the sample. */
    bandLo: round(s.bandLo),
    bandHi: round(s.bandHi),
    /** Records whose attack speed lands below zero (weight > speed + con). */
    negative: s.negative,
    /** Records with `+3` bit 0 clear, i.e. no autolevel at all. */
    noAutolevel: s.noAutolevel,
  });

  const classesOf = (sub: readonly EnemySample[]) => {
    const grouped = new Map<string, EnemySample[]>();
    for (const s of sub) {
      const key = `${s.classId}`;
      const list = grouped.get(key) ?? [];
      list.push(s);
      grouped.set(key, list);
    }
    return [...grouped.values()]
      .map((list) => ({
        classId: list[0]!.classId,
        className: list[0]!.className,
        count: list.length,
        /** The class's own base speed, before the character delta and autolevel. */
        classBaseSpd: list[0]!.classBaseSpd,
        /** Mean signed character-table delta across these records. */
        meanUnitSpdDelta: round(
          list.reduce((a, s) => a + s.unitSpdDelta, 0) / list.length,
        ),
        meanAs: round(summarizeAs(list).mean),
        medianAs: round(summarizeAs(list).median),
      }))
      .sort((a, b) => b.count - a.count);
  };

  const chapters = loaded.chapters
    .map((chapter) => {
      const sub = samples.filter((s) => s.mapIndex === chapter.index);
      if (sub.length === 0) return null;
      return {
        mapIndex: chapter.index,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title,
        startEvent:
          chapter.startEventAddr === 0
            ? null
            : `0x${chapter.startEventAddr.toString(16).toUpperCase()}`,
        summary: summary(summarizeAs(sub)),
        /**
         * The same records priced with the **first** weapon in each record
         * instead of the heaviest. Quoted so the report can say how much the
         * one input we cannot read (the AI's weapon choice) is worth.
         */
        firstWeaponSummary: summary(summarizeAs(sub, attackSpeedFirstWeapon)),
        classes: classesOf(sub),
      };
    })
    .filter((x) => x !== null);

  const routine = (r: AutolevelRoutine) => samples.filter((s) => s.routine === r);

  const negative = samples
    .filter((s) => s.as.mean < 0)
    .map((s) => ({
      mapIndex: s.mapIndex,
      className: s.className,
      level: s.level,
      spd: round(s.spd.mean),
      con: s.con,
      weight: s.weight,
      as: round(s.as.mean),
    }));

  return {
    rom: loaded.path,
    hardMode: options.hard,
    totals: {
      records: samples.length,
      promoted: samples.filter((s) => s.promoted).length,
      byRoutine: {
        /** `AutolevelUnit`: class growths, `level - 1` rounds. */
        unit: routine('unit').length,
        /** `AutolevelRealistic`: the character's own growths, simulated. */
        realistic: routine('realistic').length,
        /** `+3` bit 0 clear: the record keeps its raw stats. */
        none: routine('none').length,
      },
      /** Records with no weapon in `+12..15`, so no weight penalty. */
      noWeapon: samples.filter((s) => s.weight === 0).length,
      negativeAs: negative.length,
      /** Enemy records whose class id did not resolve; 0 expected. */
      unresolvedClass,
    },
    overall: summary(summarizeAs(samples)),
    byRoutine: {
      unit: summary(summarizeAs(routine('unit'))),
      realistic: summary(summarizeAs(routine('realistic'))),
      none: summary(summarizeAs(routine('none'))),
    },
    chapters,
    /**
     * Every projected record, flat. Per-chapter summaries cannot be combined
     * into a route phase exactly, so the raw rows are emitted and consumers
     * aggregate for themselves.
     */
    samples: samples.map((s) => ({
      mapIndex: s.mapIndex,
      unitId: s.unitId,
      classId: s.classId,
      className: s.className,
      level: s.level,
      grow: s.grow,
      routine: s.routine,
      promoted: s.promoted,
      spd: round(s.spd.mean),
      con: s.con,
      weight: s.weight,
      weightFirst: s.weightFirst,
      as: round(s.as.mean),
    })),
    /** Every record whose attack speed came out below zero, with its inputs. */
    negativeSamples: negative,
    limitations: [
      'Attack speed is `speed - max(0, weapon weight - constitution)`, the same formula `BattleLoadAS @ 0x0802AB74` runs for both sides. It is signed: nothing clamps it at zero, so a Gorgon Egg holding a 10-weight tome really does sit at -4.',
      'Weapon weight uses the **heaviest** weapon in the record (worst case for the enemy, best case for the player). Which weapon the AI actually picks is the one input this projection cannot read from the ROM; `firstWeaponSummary` prices the other convention, and the two differ by about 0.2 attack speed.',
      'Autolevel burns random numbers (`NextRN_N` in `GetAutoleveledStat`, `Roll1RN` in `GetStatIncrease`), so `mean` is exact in expectation but no single playthrough reproduces it. `bandLo`/`bandHi` bracket what the RNG can reach.',
      'Only placement blocks reachable from a condition-slot script are seen. Blocks referenced from TRAP slots or from code the opcode table does not know are invisible, and the walk gives up after ten consecutive unknown instructions - so the sample is a lower bound on the enemy count, not a census.',
      'The `realistic` routine simulates one level-up per level with the character\'s own growths. Its mean is exact; its band is quoted as `mean +/- 2 standard deviations` of the equivalent binomial, not as the ROM\'s own reachable set.',
    ],
  };
}

function cmdObjects(loaded: LoadedRom, options: CliOptions): unknown {
  const byKind: Record<string, number> = {};
  for (const o of loaded.mapObjects) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;

  const chapterOf = (index: number) => loaded.chapters.find((c) => c.index === index) ?? null;

  const chapters = loaded.chapterObjects
    .filter((c) => (options.all ? true : c.objects.length > 0))
    .map((c) => ({
      mapIndex: c.chapterIndex,
      chapterNumber: c.chapterNumber,
      title: c.title,
      objects: c.objects.map((o) => {
        const item = o.itemId === null ? undefined : loaded.itemMap.get(o.itemId);
        return {
          kind: o.kind,
          triggerType: `0x${o.type.toString(16).toUpperCase()}`,
          objectType: `0x${o.objectType.toString(16).toUpperCase()}`,
          objectTypeName: o.objectTypeName,
          /** Achievement flag; 0 means the object can be used more than once. */
          flag: o.flag,
          x: o.x,
          y: o.y,
          address: `0x${o.addr.toString(16).toUpperCase()}`,
          /** Chests only: the item inside, and what it would sell for. */
          ...(o.kind === 'chest'
            ? {
                itemId: o.itemId,
                itemName: o.isGoldChest ? 'Gold' : (item?.name ?? `item#${o.itemId}`),
                /** Chests store gold in `+6`, and mark a gold chest with item 0x77. */
                gold: o.gold,
                isGoldChest: o.isGoldChest,
                sellPrice: o.isGoldChest ? 0 : (item?.sellPrice ?? 0),
              }
            : {}),
          /** Villages and houses: the script the object runs. */
          ...(o.eventAddr ? { event: `0x${o.eventAddr.toString(16).toUpperCase()}` } : {}),
          /** Shops: the 2-byte entry list (see the `shops` command). */
          ...(o.shopAddr ? { shopList: `0x${o.shopAddr.toString(16).toUpperCase()}` } : {}),
        };
      }),
    }));

  const goldChests = chapters
    .flatMap((c) => c.objects.filter((o) => 'isGoldChest' in o && o.isGoldChest).map((o) => ({ ...o, title: c.title, mapIndex: c.mapIndex })))
    .map((o) => ({ mapIndex: o.mapIndex, title: o.title, amount: (o as { gold: number }).gold }));

  return {
    objectCount: loaded.mapObjects.length,
    byKind,
    /** Chests that pay gold. FE8 stores the amount at `+6`, not in the item table. */
    goldChestTotal: goldChests.reduce((s, g) => s + g.amount, 0),
    goldChests,
    chapters,
    limitations: [
      'All five object kinds share one 12-byte record. `+4` is overloaded: a ' +
        'shop stores a pointer to its entry list there, a chest stores the item ' +
        'id in the low byte and the gold amount at `+6`, and everything else ' +
        'stores a pointer to its event script.',
      'Chest and village contents are the ROM\'s main source of money and free ' +
        'weapons, and neither is in the item table\'s price column: a gold chest ' +
        'names item 0x77 (Gold, price 0) and carries its value at `+6`.',
      'Most chests in this hack have achievement flag 0, which normally means ' +
        'the object can be triggered repeatedly. That is what the ROM says; it ' +
        'is reported as-is.',
      'Doors are listed but carry no loot.',
    ],
  };
}

/** Largest `--range` span we will expand, to keep output bounded. */
const MAX_TEXT_RANGE = 4096;

function parseTextIds(specs: readonly string[], range: string | undefined): number[] {
  const ids: number[] = [];

  for (const spec of specs) {
    const id = Number.parseInt(spec, 0); // radix 0 accepts 0x-prefixed input
    if (Number.isNaN(id)) throw new Error(`not a text id: "${spec}"`);
    ids.push(id);
  }

  if (range !== undefined) {
    const match = /^(0x[0-9a-f]+|\d+)\s*-\s*(0x[0-9a-f]+|\d+)$/i.exec(range);
    if (!match) throw new Error(`--range expects "start-end", got "${range}"`);
    const start = Number.parseInt(match[1] as string, 0);
    const end = Number.parseInt(match[2] as string, 0);
    if (end < start) throw new Error('--range: end is before start');
    if (end - start + 1 > MAX_TEXT_RANGE) {
      throw new Error(`--range spans more than ${MAX_TEXT_RANGE} ids`);
    }
    for (let id = start; id <= end; id++) ids.push(id);
  }

  return ids;
}

function cmdText(loaded: LoadedRom, options: CliOptions): unknown {
  const ids = parseTextIds(options.args, options.range);
  if (ids.length === 0) {
    throw new Error('give at least one text id, or --range a-b');
  }

  return ids.map((id) => {
    const decoded = decodeTextIdDetailed(loaded.rom, id, loaded.text);
    return {
      id,
      idHex: `0x${id.toString(16).toUpperCase()}`,
      // 'huffman' | 'unhuffman' | 'direct' | 'invalid' - hacks mix the first two.
      kind: decoded.kind,
      text: decoded.text,
      raw: decoded.raw,
    };
  });
}

function cmdValidate(loaded: LoadedRom): unknown {
  const result = validateRom(loaded);
  return {
    ok: result.ok,
    summary: result.summary,
    checks: result.checks,
    supportDetail: result.supports,
  };
}

function main(): void {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options) return;

  const KNOWN_COMMANDS = [
    'info',
    'units',
    'classes',
    'roles',
    'supports',
    'terrain',
    'chapters',
    'items',
    'shops',
    'text',
    'objects',
    'enemy-stats',
    'dump',
    'validate',
  ] as const;

  if (!(KNOWN_COMMANDS as readonly string[]).includes(options.command)) {
    console.error(`error: unknown command "${options.command}"\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  let loaded: LoadedRom;
  try {
    loaded = loadRom(options.romPath);
  } catch (error) {
    if (error instanceof UnsupportedRomError) {
      console.error(`error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  try {
    switch (options.command) {
      case 'info':
        emit(cmdInfo(loaded), options);
        break;
      case 'units':
        emit(cmdUnits(loaded, options), options);
        break;
      case 'classes':
        emit(cmdClasses(loaded, options), options);
        break;
      case 'roles':
        emit(cmdRoles(loaded, options), options);
        break;
      case 'supports':
        emit(cmdSupports(loaded), options);
        break;
      case 'terrain':
        emit(cmdTerrain(loaded, options), options);
        break;
      case 'chapters':
        emit(cmdChapters(loaded, options), options);
        break;
      case 'items':
        emit(cmdItems(loaded, options), options);
        break;
      case 'shops':
        emit(cmdShops(loaded, options), options);
        break;
      case 'text':
        emit(cmdText(loaded, options), options);
        break;
      case 'objects':
        emit(cmdObjects(loaded, options), options);
        break;
      case 'enemy-stats':
        emit(cmdEnemyStats(loaded, options), options);
        break;
      case 'dump':
        emit(buildReport(loaded), options);
        break;
      case 'validate': {
        const result = cmdValidate(loaded);
        emit(result, options);
        if (!(result as { ok: boolean }).ok) process.exitCode = 1;
        break;
      }
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
