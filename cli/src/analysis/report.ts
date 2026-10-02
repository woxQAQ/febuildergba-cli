/**
 * Builds the JSON payload that gets handed to an AI for "which units should I
 * train, and how should I pair supports?".
 *
 * The shape is deliberately flat and self-describing: every number is labelled,
 * and every derived field states the convention that produced it.
 *
 * **What belongs here and what does not.** This file may only emit things that
 * can be traced to a ROM byte or to a C# file in `FEBuilderGBA/`. Author-chosen
 * numbers - weights, thresholds, rankings, "this unit is a debug unit" calls,
 * phase labels - are **judgement** and belong to the consumer, not to the CLI.
 * Two tests for a field:
 *
 *   1. Can you name the byte or the reference source it comes from?
 *   2. Would two reasonable people disagree about the definition? If yes, it is
 *      a judgement call, and putting it here makes it look like a ROM fact.
 *
 * The `derived` ranking block that used to live here (`growthRanking`,
 * `supportRanking`, `bestGrowthPerStat`, `roleCoverage`) failed both tests and
 * was removed. It is trivially re-derivable from `units[]` by whoever needs it.
 */

import type { LoadedRom } from '../load.ts';
import type { Unit } from '../tables/units.ts';
import type { UnitClass } from '../tables/classes.ts';
import type { SupportGraphEdge, SupportRank } from '../tables/supports.ts';
import {
  SUPPORT_CONVERSATION_CAPS,
  SUPPORT_LIMIT,
  SUPPORT_RANK_THRESHOLDS,
  supportRankPlan,
} from '../tables/supports.ts';
import type { Mobility } from './roles.ts';
import type { WeaponType } from '../tables/common.ts';
import {
  affinityName,
  rankedBonus,
  MAX_SIMULTANEOUS_SUPPORT_LEVELS,
  SUPPORT_BONUSES_MAX_DISTANCE,
  SUPPORT_EXP_DISTANCE,
} from '../tables/supportBonus.ts';
import type { Chapter, JoinSource } from '../tables/chapters.ts';

export interface RomMeta {
  file: string;
  sizeBytes: number;
  sizeHex: string;
  gameCode: string;
  title: string;
  version: string;
  displayName: string;
  isMultibyte: boolean;
  tableAddresses: {
    unitSlot: number;
    unitTable: number;
    unitRecordSize: number;
    classSlot: number;
    classTable: number;
    classRecordSize: number;
    huffmanTreeBase: number;
    huffmanDataBase: number;
    textTableBase: number;
  };
  notes: string[];
}

/**
 * The parts of a class role that matter for team building, flattened onto the
 * unit so a reader does not have to join two arrays.
 */
export interface UnitRoleReport {
  /** Terrain mobility relative to infantry. See `analysis/roles.ts`. */
  mobility: Mobility;
  /** Weapon types the class can use. */
  weapons: WeaponType[];
  /** Can use staves - the class can heal. */
  hasStaff: boolean;
  /** Can use anima / light / dark tomes. */
  isMagic: boolean;
}

export interface UnitReport {
  id: number;
  /** Display name, with `@XXXX` text escapes stripped. */
  name: string;
  /** Same name with the escapes left in; differs only where the ROM has one. */
  nameRaw: string;
  className: string;
  classId: number;
  level: number;
  /**
   * **Per-unit deltas, signed.** These are *not* the stats the unit starts
   * with: the game adds the class base. Zero is the normal value and just means
   * "no adjustment"; a negative value is legal.
   */
  stats: Unit['stats'];
  /**
   * `class base + stats` - what the unit actually starts with. **Use this when
   * comparing units.** If any of these came out `<= -1` the game would wrap the
   * value to the maximum on load, which `validate` reports as an error.
   */
  startingStats: Unit['startingStats'];
  growths: Unit['growths'];
  growthTotal: number;
  weaponLevels: Unit['weaponLevels'];
  /** Movement range, copied from the class. `null` when the class is unknown. */
  movement: number | null;
  /** Stat caps, copied from the class. */
  caps: UnitClass['caps'] | null;
  /** Promotion target name, when the class promotes. */
  promotesTo: string | null;
  supportPartnerCount: number;
  /** Support affinity from unit record `+9`. 0 when the unit has none. */
  affinity: number;
  affinityName: string;
  /** Role profile copied from the class. `null` when the class is unknown. */
  role: UnitRoleReport | null;
  /** When the unit enters the player's army. See `tables/chapters.ts`. */
  availability: UnitAvailability;
}

/**
 * Derived availability, not stored in the ROM. `joinChapter` is the map setting
 * index of the first chapter where the unit is in the initial placement block
 * or is recruited by a `LOAD1` instruction. `earliestEvidenceChapter` also
 * counts `LOAD2`/`LOAD3`, which load units that are *already* in the party -
 * so when it is lower, the real join is at or before it.
 */
export interface UnitAvailability {
  /** Map setting index, or `null` when no evidence was found. */
  joinChapter: number | null;
  /**
   * **The number the game shows**, i.e. `Chapter.chapterNumber`
   * (`u16(record + 0x80) / 2`). `null` when there is no join evidence.
   *
   * Prefer this over `joinChapter`. The map-setting index counts every row of
   * the table - unused slots, world-map maps, bonus maps - so an index of 60
   * does not mean "chapter 60"; this ROM's story ends at chapter 27.
   */
  joinChapterNumber: number | null;
  /**
   * Chapter title for `joinChapter`, e.g. `C7A: ... Into the ...`.
   *
   * `@001F` (world-map encounter) or `''` (unused slot) means the join evidence
   * points at a map that is not a story chapter, so treat the row as unreliable.
   */
  joinChapterTitle: string | null;
  /**
   * True when the join evidence lands on a map that actually has a title, i.e.
   * a story chapter, the prologue, or a named bonus map. **False means the row
   * should be treated as unreliable** - the evidence points at an unused slot or
   * a world-map encounter map.
   *
   * Pair this with `joinChapterNumber`: the prologue and bonus maps are real
   * maps but have no chapter number.
   */
  joinChapterIsStory: boolean | null;
  joinSource: Extract<JoinSource, 'placement' | 'recruit'> | null;
  /** Where the evidence lives: a placement record or an instruction address. */
  evidenceAddr: number | null;
  earliestEvidenceChapter: number | null;
  earliestEvidenceChapterNumber: number | null;
  earliestEvidenceSource: JoinSource | null;
}

export interface ChapterReport {
  mapIndex: number;
  /** The game's own chapter number (`+0x80 / 2`); 0 = unused slot or bonus map. */
  chapterNumber: number;
  chapterNumberRaw: number;
  /**
   * Chapter title decoded from `+0x70`. `''` means an unused slot; `@001F`
   * means a world-map encounter map; `C7A: ...` etc. are real story chapters.
   */
  title: string;
  titleTextId: number;
  eventPlist: number;
  condTableAddr: number | null;
  startEventAddr: number | null;
  endEventAddr: number | null;
  playerPlacementAddr: number | null;
  /** Units on the field at the start of the chapter. */
  roster: {
    id: number;
    name: string;
    placedClassId: number;
    level: number;
    /** Staging coordinate; the final one is in the post-placement array. */
    prePlacementCoord: { x: number; y: number; ext: number | null };
    postPlacementCoords: number;
    classOverridden: boolean;
  }[];
  /** Instructions that load units mid-chapter. */
  recruitSites: {
    kind: JoinSource;
    slot: string;
    address: number;
    instruction: string;
    block: number;
    unitIds: number[];
  }[];
  /**
   * Direct gold writes in this chapter's scripts, from the two literal
   * instructions `40050300XXXX000021370000` (gain) / `...22370000` (lose).
   * Money bags handed out as items are in `itemsGiven`, not here.
   */
  goldEvents: { address: number; delta: number; instruction: string }[];
  /**
   * Items this chapter's scripts hand to the player, with the item's price so
   * money bags (`Gold`, `3,000 Gold`, ...) can be valued.
   */
  itemsGiven: {
    address: number;
    itemId: number;
    name: string;
    /** 0xFFFF means "the visiting/acting unit". */
    unitId: number;
    /** The item's `+26` price field; for a money bag this IS the gold amount. */
    unitPrice: number;
  }[];
  /** Script walks abandoned after ten consecutive unknown opcodes. */
  truncatedScriptWalks: number;
}

export interface SupportEdgeReport {
  a: number;
  aName: string;
  b: number;
  bName: string;
  initial: number;
  growth: number;
  /** Rank the pair already holds at chapter 1, from `initial`. */
  startingRank: SupportRank;
  /**
   * Turns of adjacency needed before each rank's support conversation unlocks.
   * Talking costs no turns, so these are also the marginal costs per rank.
   */
  turnsToConversation: Record<Exclude<SupportRank, 'none'>, number | null>;
  /**
   * Cumulative turns of adjacency before the pair's support value reaches each
   * rank. A lower bound: it assumes each conversation is taken the moment it
   * unlocks, and ignores the one-support-level-per-chapter rule.
   */
  turnsTo: Record<Exclude<SupportRank, 'none'>, number | null>;
  reciprocal: boolean;
  mismatch?: { initial: number; growth: number };
}

export interface Report {
  meta: RomMeta;
  units: UnitReport[];
  classes: {
    id: number;
    name: string;
    movement: number;
    promotesToClassId: number;
    promotesTo: string | null;
    bases: UnitClass['bases'];
    caps: UnitClass['caps'];
    promotionBonuses: UnitClass['promotionBonuses'];
    weaponLevels: UnitClass['weaponLevels'];
  }[];
  supports: {
    edges: SupportEdgeReport[];
    /** Per-unit support summary, including who they can support. */
    byUnit: {
      id: number;
      name: string;
      partnerCount: number;
      declaredCount: number;
      partners: {
        id: number;
        name: string;
        initial: number;
        growth: number;
        startingRank: SupportRank;
        turnsToConversation: Record<Exclude<SupportRank, 'none'>, number | null>;
        turnsTo: Record<Exclude<SupportRank, 'none'>, number | null>;
      }[];
    }[];
    limit: number;
    /**
     * Support-point totals that define each rank, as a pair holds them *after*
     * taking the conversation. From `SupportUnitForm.Designer.cs:460` and
     * confirmed by the ROM's own `GetSupportLevelBySupportIndex`.
     */
    rankThresholds: typeof SUPPORT_RANK_THRESHOLDS;
    /**
     * Point totals at which each rank's conversation unlocks - one below the
     * rank itself, because support points are clamped to the cap for the pair's
     * current rank.
     */
    conversationCaps: typeof SUPPORT_CONVERSATION_CAPS;
    /**
     * `bonusRange` is how far a support bonus reaches; `expRange` is how close
     * the pair must be to gain points. Both Manhattan (`|dx| + |dy|`).
     */
    distances: { bonusRange: number; expRange: number };
    /** Support levels one unit may hold in total (A=3, B=2, C=1). */
    maxTotalSupportLevels: number;
  };
  /**
   * Support-affinity bonus table, straight from the ROM, plus the derived
   * per-rank values.
   *
   * Each row is **one affinity**, not one rank: the ROM stores 7 rows and the
   * game scales by the support level (none/C/B/A = 0/1/2/3), summing *both*
   * units' rows and halving once at the end.
   *
   * `bonuses` holds the raw stored bytes, which are **half-points** - the
   * reason every row reads `atk=1` and `critAvoid=5`. Use `byRank` for the
   * numbers a player would see. Verified against the ROM's own
   * `StoreAddedAffinityBonusesForSupportLevel`; see `tables/supportBonus.ts`.
   */
  supportAffinities: {
    affinity: number;
    affinityName: string;
    /** Bytes 1..7 of the record, keyed by the reference's own field labels. */
    bonuses: Record<string, number>;
    /** The six real stats at each rank, after the game's final halving. */
    byRank: Record<'C' | 'B' | 'A', Record<string, number>>;
    raw: number[];
  }[];
  /**
   * Terrain names indexed by terrain id, the same id a class's movement-cost
   * table uses. This is what turns "cost 0xFF at index 0x12" into "Peak".
   */
  terrainNames: {
    table: {
      slot: number;
      address: number;
      recordSize: number;
      count: number;
      /** 4 = pointer to a raw string; 2 = text id. */
      isMultibyte: boolean;
    } | null;
    names: {
      id: number;
      name: string;
      textId: number | null;
      nameAddress: number | null;
      decoded: boolean;
    }[];
  };
  /**
   * Item catalogue. Prices are derived: the ROM stores a **unit price**
   * (`+26`), the shop charges `uses x unitPrice` and a sale returns half that
   * (`ItemForm.cs:309-311`).
   */
  items: {
    table: {
      slot: number;
      address: number;
      recordSize: number;
      entriesRead: number;
      nonEmpty: number;
    } | null;
    entries: {
      id: number;
      name: string;
      type: string;
      rank: string;
      /** Raw `+28` weapon-rank byte; a unit can equip when its own level >= this. */
      rankValue: number;
      uses: number;
      might: number;
      hit: number;
      crit: number;
      weight: number;
      range: string;
      wexp: number;
      unitPrice: number;
      buyPrice: number;
      sellPrice: number;
    }[];
  };
  /**
   * Shops: the prep-screen armoury plus every per-map shop, each with the item
   * ids and prices it offers. See `tables/shops.ts` for the three sources and
   * which ones are wired up.
   */
  shops: {
    prepShopAddress: number;
    count: number;
    entries: {
      label: string;
      kind: string;
      mapIndex: number | null;
      chapterNumber: number | null;
      address: number;
      items: { itemId: number; name: string; uses: number; price: number }[];
    }[];
  };
  /**
   * Map objects: chests, villages, doors, seize points and shops. They all live
   * in the same 12-byte `CONDTYPE.OBJECT` records - see `tables/mapObjects.ts`.
   * Chest contents in particular are **only** in these records, not in the
   * event scripts, so this block is where the game's money and free weapons
   * actually come from.
   */
  objects: {
    count: number;
    byKind: Record<string, number>;
    /** Chests that pay gold instead of holding an item. */
    goldChests: { mapIndex: number; chapterNumber: number; title: string; amount: number }[];
    /** Chests that hold an item. */
    itemChests: {
      mapIndex: number;
      chapterNumber: number;
      title: string;
      itemId: number;
      name: string;
      /** What it would fetch if sold: half of `uses x unitPrice`. */
      sellPrice: number;
      flag: number;
    }[];
  };
  /**
   * Inputs a "who should I train, and how should I pair supports" analysis
   * needs but that this ROM parse cannot supply. Read this before drawing
   * conclusions.
   */
  limitations: string[];
  /** Per-chapter rosters and mid-chapter recruit sites. */
  chapters: ChapterReport[];
  availability: {
    /** Map setting table address and how its record count was determined. */
    mapSettings: {
      slot: number;
      table: number;
      recordSize: number;
      count: number;
      countSource: 'terminator' | 'structural';
    } | null;
    /** Opcode table used to walk event scripts, or `null` when absent. */
    eventOpcodeTable: string | null;
    eventOpcodes: number;
    /** Condition-slot kinds, in table order. */
    conditionSlots: { index: number; flag: string; kind: string; name: string }[];
    /** Evidence counts. */
    stats: {
      placementsExamined: number;
      classOverriddenPlacements: number;
      sitesByKind: Record<JoinSource, number>;
      unitsWithJoinEvidence: number;
      unitsWithAnyAppearance: number;
    };
    /**
     * Join order, one row per unit, sorted by chapter. Restricted to units that
     * carry support data. A row with `joinChapter: null` has no recruit
     * instruction naming it and is only loaded - see `earliestEvidenceChapter`.
     */
    joinOrder: {
      id: number;
      name: string;
      joinChapter: number | null;
      /** The game's own chapter number for `joinChapter`; prefer this. */
      joinChapterNumber: number | null;
      /** Chapter title for `joinChapter`; prefer this over the raw index. */
      joinChapterTitle: string | null;
      /** False when the join evidence lands on a non-story map; treat as unreliable. */
      joinChapterIsStory: boolean | null;
      joinSource: string | null;
      earliestEvidenceChapter: number | null;
      earliestEvidenceChapterNumber: number | null;
      earliestEvidenceSource: string | null;
      /** True when a `LOAD2`/`LOAD3` predates the `LOAD1` join. */
      joinMayBeEarlier: boolean;
    }[];
  };
}

/**
 * Look a map-setting row up by its index. The index is a row handle, not a
 * chapter number - see `Chapter.chapterNumber`.
 */
function chapterOf(loaded: LoadedRom, index: number | null | undefined): Chapter | null {
  if (index === null || index === undefined) return null;
  return loaded.chapters.find((c) => c.index === index) ?? null;
}

/**
 * True when a map-setting row names a real map: it has a title, and that title
 * is not the world-map glyph. Unused slots (empty title) and skirmish maps
 * (`@001F`) fail; the prologue and named bonus maps pass.
 *
 * Do **not** test `chapterNumber` alone for this: the prologue legitimately
 * carries chapter number 0, the same value as an unused slot.
 */
export function isStoryTitle(title: string): boolean {
  return title !== '' && title !== '@001F';
}

function isStoryChapter(chapter: Chapter | null): boolean | null {
  return chapter === null ? null : isStoryTitle(chapter.title);
}

function toUnitReport(unit: Unit, loaded: LoadedRom): UnitReport {
  const cls = loaded.classes.find((c) => c.id === unit.classId);
  const promotesTo =
    cls && cls.promotesToClassId !== 0
      ? (loaded.classNames.get(cls.promotesToClassId) ?? `class ${cls.promotesToClassId}`)
      : null;

  const entry = loaded.supports.entries.find((e) => e.unitId === unit.id);
  const role = loaded.classRoles.get(unit.classId);

  const join = loaded.joins.joins.get(unit.id);
  const appearance = loaded.joins.appearances.get(unit.id);
  const joinChapter = chapterOf(loaded, join?.chapterIndex);
  const appearanceChapter = chapterOf(loaded, appearance?.chapterIndex);
  const availability: UnitAvailability = {
    joinChapter: join?.chapterIndex ?? null,
    joinChapterNumber: joinChapter?.chapterNumber ?? null,
    joinChapterTitle: joinChapter?.title ?? null,
    joinChapterIsStory: isStoryChapter(joinChapter),
    joinSource: join?.source === 'placement' || join?.source === 'recruit' ? join.source : null,
    evidenceAddr: join?.evidenceAddr ?? null,
    earliestEvidenceChapter: appearance?.chapterIndex ?? null,
    earliestEvidenceChapterNumber: appearanceChapter?.chapterNumber ?? null,
    earliestEvidenceSource: appearance?.source ?? null,
  };

  return {
    id: unit.id,
    name: unit.name,
    nameRaw: unit.nameRaw,
    className: unit.className,
    classId: unit.classId,
    level: unit.level,
    stats: unit.stats,
    startingStats: unit.startingStats,
    growths: unit.growths,
    growthTotal: unit.growthTotal,
    weaponLevels: unit.weaponLevels,
    movement: cls?.movementRange ?? null,
    caps: cls?.caps ?? null,
    promotesTo,
    supportPartnerCount: entry?.partners.length ?? 0,
    affinity: unit.attribute,
    affinityName:
      unit.attribute === 0
        ? ''
        : (loaded.affinityNames.get(unit.attribute) ?? affinityName(unit.attribute)),
    role: role
      ? {
          mobility: role.mobility,
          weapons: role.weapons,
          hasStaff: role.hasStaff,
          isMagic: role.isMagic,
        }
      : null,
    availability,
  };
}

/**
 * Why some inputs are missing or uncertain. Written out so a downstream reader
 * does not quietly invent them.
 */
const LIMITATIONS: readonly string[] = [
  'Join chapter is DERIVED, not stored. It comes from the chapter\'s initial ' +
    'placement block plus `LOAD1` ("自軍ユニットは仲間にする") instructions found ' +
    'by walking event scripts. See `tables/chapters.ts` for the full chain.',
  'A placement record only counts as the named character when its class id is 0 ' +
    'or matches the unit\'s own class. Hack authors reuse one unit id as a ' +
    'generic template with varying class ids; `classOverriddenPlacements` ' +
    'counts those.',
  'Hack chapters often share one "load the whole party" script between several ' +
    'maps, so a `LOAD1` seen in a late chapter is usually a re-load, not a join. ' +
    'When `earliestEvidenceChapter` (which includes `LOAD2`) is lower than ' +
    '`joinChapter`, `joinMayBeEarlier` is true - the real join is probably ' +
    'earlier.',
  'Script-derived entries are deduplicated **within** a chapter, never across ' +
    'chapters. One script can be referenced by many maps, so the same `address` ' +
    'shows up under every chapter that reaches it: `goldEvents`, `itemsGiven` ' +
    'and the placement blocks all need deduplicating by address before you sum ' +
    'or count them. A single 5,000-gold script shared by 17 maps is one payout, ' +
    'not 85,000 gold.',
  'Script walks stop after ten consecutive unrecognised opcodes, matching ' +
    'FEBuilderGBA. `truncatedScriptWalks` per chapter counts those; a recruit ' +
    'instruction after such a stop is missed.',
  'Support bonuses are computed, not transcribed. A bonus is the sum of BOTH ' +
    'units\' affinity rows - each scaled by its own support level (none/C/B/A = ' +
    '0/1/2/3) - halved once at the end. `supportAffinities[].bonuses` holds the ' +
    'raw stored bytes, which are HALF-points; use `.byRank` for the C/B/A ' +
    'numbers a player sees. Verified against the ROM\'s own ' +
    '`StoreAddedAffinityBonusesForSupportLevel`; see `tables/supportBonus.ts`.',
  'Support points only accumulate while a pair is adjacent (`|dx| + |dy| <= 1`, ' +
    'or one carrying the other), but the bonus reaches 3 tiles. A pair can only ' +
    'gain one level per chapter, and a unit may hold at most 5 support levels in ' +
    'total (A=3, B=2, C=1). `turnsTo` ignores the per-chapter cap, so treat it as ' +
    'a lower bound on the chapters needed.',
  'Units in this table are every populated slot, not just the player roster. ' +
    'Enemies, bosses and generic templates are in here too. Having support data ' +
    'is a useful proxy for "playable" but it is a proxy, not a flag.',
  'A unit\'s `stats` are PER-UNIT DELTAS, not the stats the unit starts with. ' +
    'The game computes `startingStat = class base + unit delta`, which is what ' +
    '`startingStats` holds. The field is signed and may be negative; 0 is the ' +
    'normal value and only means "no adjustment". Compare units with ' +
    '`startingStats`, never with `stats`.',
  'Base stats and growth rates are separate things: `stats` is what the unit ' +
    'has at level 1 (per-unit part), `growths` is the per-level-up chance. A ' +
    'high growth does not make a unit good early, and a low per-unit delta does ' +
    'not make it weak - check `startingStats` against the class base.',
];

function buildChapters(loaded: LoadedRom): ChapterReport[] {
  return loaded.chapters.map((chapter) => {
    const scan = loaded.chapterScans.find((s) => s.chapterIndex === chapter.index);
    return {
      mapIndex: chapter.index,
      chapterNumber: chapter.chapterNumber,
      chapterNumberRaw: chapter.chapterNumberRaw,
      title: chapter.title,
      titleTextId: chapter.titleTextId,
      eventPlist: chapter.eventPlist,
      condTableAddr: chapter.condTableAddr === 0 ? null : chapter.condTableAddr,
      startEventAddr: chapter.startEventAddr === 0 ? null : chapter.startEventAddr,
      endEventAddr: chapter.endEventAddr === 0 ? null : chapter.endEventAddr,
      playerPlacementAddr:
        chapter.playerPlacementAddr === 0 ? null : chapter.playerPlacementAddr,
      roster: chapter.placements.map((p) => {
        const own = loaded.units.find((u) => u.id === p.unitId)?.classId;
        return {
          id: p.unitId,
          name: loaded.unitNames.get(p.unitId) ?? '',
          placedClassId: p.classId,
          level: p.level,
          prePlacementCoord: p.prePlacementCoord,
          postPlacementCoords: p.postPlacementCount,
          classOverridden: p.classId !== 0 && p.classId !== own,
        };
      }),
      recruitSites: (scan?.recruits ?? []).map((site) => ({
        kind: site.kind,
        slot: site.slotKind,
        address: site.addr,
        instruction: site.instruction,
        block: site.blockAddr,
        unitIds: site.units.map((u) => u.unitId),
      })),
      truncatedScriptWalks: scan?.truncatedWalks ?? 0,
      goldEvents: (scan?.gold ?? []).map((g) => ({
        address: g.addr,
        delta: g.delta,
        instruction: g.instruction,
      })),
      itemsGiven: (scan?.itemsGiven ?? []).map((g) => {
        const item = loaded.itemMap.get(g.itemId);
        return {
          address: g.addr,
          itemId: g.itemId,
          name: item?.name ?? `item#${g.itemId}`,
          unitId: g.unitId,
          unitPrice: item?.unitPrice ?? 0,
        };
      }),
    };
  });
}

export function buildReport(loaded: LoadedRom): Report {
  const playableUnits = loaded.units.filter((u) => !u.isEmpty);

  const units = playableUnits.map((u) => toUnitReport(u, loaded));

  const classes = loaded.classes
    .filter((c) => !c.isEmpty)
    .map((c) => ({
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
    }));

  const edges: SupportEdgeReport[] = loaded.supportGraph.map((e: SupportGraphEdge) => ({
    a: e.a,
    aName: e.aName,
    b: e.b,
    bName: e.bName,
    initial: e.initial,
    growth: e.growth,
    ...supportRankPlan(e.initial, e.growth),
    reciprocal: e.reciprocal,
    ...(e.mismatch ? { mismatch: e.mismatch } : {}),
  }));

  const byUnit = loaded.supports.entries.map((entry) => ({
    id: entry.unitId,
    name: entry.unitName,
    partnerCount: entry.partners.length,
    declaredCount: entry.declaredCount,
    partners: entry.partners.map((p) => ({
      id: p.unitId,
      name: p.unitName,
      initial: p.initial,
      growth: p.growth,
      ...supportRankPlan(p.initial, p.growth),
    })),
  }));

  const terrainTable = loaded.terrainNames.table;
  const terrainNames: Report['terrainNames'] = {
    table:
      terrainTable === null
        ? null
        : {
            slot: terrainTable.slotOffset,
            address: terrainTable.tableOffset,
            recordSize: terrainTable.recordSize,
            count: terrainTable.count,
            isMultibyte: terrainTable.isMultibyte,
          },
    names: loaded.terrainNames.names.map((n) => ({
      id: n.id,
      name: n.name,
      textId: n.textId,
      nameAddress: n.nameAddress,
      decoded: n.decoded,
    })),
  };

  const meta: RomMeta = {
    file: loaded.path,
    sizeBytes: loaded.rom.length,
    sizeHex: `0x${loaded.rom.length.toString(16).toUpperCase()}`,
    gameCode: loaded.identity.gameCode,
    title: loaded.identity.title,
    version: loaded.layout.version,
    displayName: loaded.layout.displayName,
    isMultibyte: loaded.layout.text.isMultibyte,
    tableAddresses: {
      unitSlot: loaded.unitTable.slotOffset,
      unitTable: loaded.unitTable.tableOffset,
      unitRecordSize: loaded.unitTable.recordSize,
      classSlot: loaded.classTable.slotOffset,
      classTable: loaded.classTable.tableOffset,
      classRecordSize: loaded.classTable.recordSize,
      huffmanTreeBase: loaded.text.treeBase,
      huffmanDataBase: loaded.text.treeDataBase,
      textTableBase: loaded.text.textBase,
    },
    notes: loaded.identity.notes,
  };

  const supportAffinities: Report['supportAffinities'] = loaded.supportBonuses.map((b) => ({
    affinity: b.affinity,
    affinityName: loaded.affinityNames.get(b.affinity) ?? b.affinityName,
    bonuses: b.bonuses,
    byRank: rankedBonus(b) as Record<'C' | 'B' | 'A', Record<string, number>>,
    raw: b.raw,
  }));

  const supportUnitIds = new Set(loaded.supports.entries.map((e) => e.unitId));
  const joinOrder: Report['availability']['joinOrder'] = [
    ...new Set([...loaded.joins.joins.keys(), ...loaded.joins.appearances.keys()]),
  ]
    .filter((id) => supportUnitIds.has(id))
    .map((id) => {
      const join = loaded.joins.joins.get(id);
      const appearance = loaded.joins.appearances.get(id);
      const earliestChapter = appearance?.chapterIndex ?? join?.chapterIndex ?? null;
      const joinChapter = join?.chapterIndex ?? null;
      return {
        id,
        name: loaded.unitNames.get(id) ?? '',
        joinChapter,
        joinChapterNumber: chapterOf(loaded, joinChapter)?.chapterNumber ?? null,
        joinChapterTitle: chapterOf(loaded, joinChapter)?.title ?? null,
        joinChapterIsStory: isStoryChapter(chapterOf(loaded, joinChapter)),
        joinSource: join?.source ?? null,
        earliestEvidenceChapter: earliestChapter,
        earliestEvidenceChapterNumber: chapterOf(loaded, earliestChapter)?.chapterNumber ?? null,
        earliestEvidenceSource: appearance?.source ?? join?.source ?? null,
        joinMayBeEarlier:
          join !== undefined && earliestChapter !== null && earliestChapter < join.chapterIndex,
      };
    })
    .sort(
      (x, y) =>
        (x.joinChapter ?? Number.MAX_SAFE_INTEGER) - (y.joinChapter ?? Number.MAX_SAFE_INTEGER) ||
        x.id - y.id,
    );

  const availability: Report['availability'] = {
    mapSettings:
      loaded.mapSettings === null
        ? null
        : {
            slot: loaded.mapSettings.slotOffset,
            table: loaded.mapSettings.tableOffset,
            recordSize: loaded.mapSettings.recordSize,
            count: loaded.mapSettings.count,
            countSource: loaded.mapSettings.countSource,
          },
    eventOpcodeTable: loaded.eventScripts.source,
    eventOpcodes: loaded.eventScripts.scripts.length,
    conditionSlots: loaded.condSlots.map((s) => ({
      index: s.index,
      flag: s.flag,
      kind: s.kind,
      name: s.name,
    })),
    stats: {
      placementsExamined: loaded.joins.placementsExamined,
      classOverriddenPlacements: loaded.joins.classOverriddenPlacements,
      sitesByKind: loaded.joins.sitesByKind,
      unitsWithJoinEvidence: loaded.joins.joins.size,
      unitsWithAnyAppearance: loaded.joins.appearances.size,
    },
    joinOrder,
  };

  return {
    meta,
    units,
    classes,
    supports: {
      edges,
      byUnit,
      limit: SUPPORT_LIMIT,
      rankThresholds: SUPPORT_RANK_THRESHOLDS,
      conversationCaps: SUPPORT_CONVERSATION_CAPS,
      distances: {
        bonusRange: SUPPORT_BONUSES_MAX_DISTANCE,
        expRange: SUPPORT_EXP_DISTANCE,
      },
      maxTotalSupportLevels: MAX_SIMULTANEOUS_SUPPORT_LEVELS,
    },
    supportAffinities,
    terrainNames,
    limitations: [...LIMITATIONS],
    items: buildItems(loaded),
    shops: buildShops(loaded),
    objects: buildObjects(loaded),
    chapters: buildChapters(loaded),
    availability,
  };
}

// ---------------------------------------------------------------- items & shops

function buildItems(loaded: LoadedRom): Report['items'] {
  const table = loaded.itemData?.table ?? null;
  return {
    table:
      table === null
        ? null
        : {
            slot: table.slotOffset,
            address: table.tableOffset,
            recordSize: table.recordSize,
            entriesRead: table.count,
            nonEmpty: loaded.items.filter((i) => i.nameTextId !== 0).length,
          },
    entries: loaded.items
      .filter((i) => i.nameTextId !== 0)
      .map((i) => ({
        id: i.id,
        name: i.name,
        type: i.typeName,
        rank: i.weaponRankLetter,
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
      })),
  };
}

function buildShops(loaded: LoadedRom): Report['shops'] {
  const shopData = loaded.shopData;
  if (shopData === null) {
    return { prepShopAddress: 0, count: 0, entries: [] };
  }
  return {
    prepShopAddress: shopData.prepShopAddress,
    count: shopData.shops.length,
    entries: shopData.shops.map((s) => ({
      label: s.label,
      kind: s.kind,
      mapIndex: s.mapIndex,
      chapterNumber: s.chapterNumber,
      address: s.addr,
      items: s.entries.map((e) => ({
        itemId: e.itemId,
        name: e.name,
        uses: e.effectiveUses,
        price: e.price,
      })),
    })),
  };
}

function buildObjects(loaded: LoadedRom): Report['objects'] {
  const byKind: Record<string, number> = {};
  for (const o of loaded.mapObjects) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;

  const goldChests: Report['objects']['goldChests'] = [];
  const itemChests: Report['objects']['itemChests'] = [];

  for (const chapter of loaded.chapterObjects) {
    for (const o of chapter.objects) {
      if (o.kind !== 'chest') continue;
      const where = {
        mapIndex: chapter.chapterIndex,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title,
      };
      if (o.isGoldChest) {
        goldChests.push({ ...where, amount: o.gold });
        continue;
      }
      const item = o.itemId === null ? undefined : loaded.itemMap.get(o.itemId);
      itemChests.push({
        ...where,
        itemId: o.itemId ?? 0,
        name: item?.name ?? `item#${o.itemId}`,
        sellPrice: item?.sellPrice ?? 0,
        flag: o.flag,
      });
    }
  }

  return { count: loaded.mapObjects.length, byKind, goldChests, itemChests };
}
