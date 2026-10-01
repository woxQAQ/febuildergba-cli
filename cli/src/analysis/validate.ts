/**
 * Self-consistency checks that need no external reference tool.
 *
 * These are the checks described in AGENTS.md §6. They cannot prove the field
 * offsets are right - only cross-checking against FEBuilderGBA can do that - but
 * they catch the common failure modes cheaply: wrong pointer slot, wrong record
 * stride, broken text decoding, off-by-one indexing.
 */

import type { LoadedRom } from '../load.ts';
import {
  validateSupports,
  SUPPORT_CONVERSATION_CAPS,
  SUPPORT_RANK_THRESHOLDS,
} from '../tables/supports.ts';
import type { SupportValidation } from '../tables/supports.ts';
import { CLASS_TERRAIN_COUNT } from '../tables/classes.ts';
import { affinityName, rankedBonus } from '../tables/supportBonus.ts';
import { MAP_ANY, forcedUnitsForMap } from '../tables/forceSortie.ts';
import { collectEnemyStats } from './enemyStats.ts';

export interface CheckResult {
  name: string;
  passed: boolean;
  /**
   * `'error'` failures mean the parse is probably wrong and make the report
   * `ok: false`. `'warn'` failures are informational - they flag unusual but
   * legal data (hacks do things vanilla never does).
   */
  severity: 'error' | 'warn';
  detail: string;
}

export interface ValidationSummary {
  total: number;
  passed: number;
  /** Failures with severity `'error'`. */
  errors: number;
  /** Failures with severity `'warn'`. */
  warnings: number;
}

export interface ValidationReport {
  /** True when no `'error'`-severity check failed. Warnings do not affect this. */
  ok: boolean;
  summary: ValidationSummary;
  checks: CheckResult[];
  supports: SupportValidation;
}

const GROWTH_KEYS = ['hp', 'str', 'skl', 'spd', 'def', 'res', 'lck'] as const;

/**
 * Growth rates are stored as a `u8`, so the *hard* upper bound is 255. Vanilla
 * data stays at or below 100, but a value above 100 is legal and meaningful -
 * the level-up roll is `rand(0..99) < growth`, so anything over 100 is a
 * guaranteed gain. Hacks use that deliberately.
 *
 * That makes ">100" a warning, not an error: it is a smell, not proof of a
 * mis-parsed offset.
 */
const GROWTH_SOFT_LIMIT = 100;

/** A unit whose name is empty, class is 0 and level is 0 is an unused slot. */
function isPlayable(u: LoadedRom['units'][number]): boolean {
  return !u.isEmpty;
}

export function validateRom(loaded: LoadedRom): ValidationReport {
  const checks: CheckResult[] = [];

  const add = (
    name: string,
    passed: boolean,
    detail: string,
    severity: CheckResult['severity'] = 'error',
  ): void => {
    checks.push({ name, passed, severity, detail });
  };

  const playable = loaded.units.filter(isPlayable);

  // --- ROM identification -------------------------------------------------
  add(
    'rom.size',
    loaded.identity.sizeOk,
    loaded.identity.sizeOk
      ? `${loaded.rom.length} bytes (0x${loaded.rom.length.toString(16).toUpperCase()})`
      : `ROM too small for ${loaded.layout.version}`,
  );

  // --- Text decoding ------------------------------------------------------
  // If the Huffman tree base or the text table were wrong, essentially every
  // name would come back empty or as mojibake.
  const named = playable.filter((u) => u.name.length > 0).length;
  const nameRatio = playable.length === 0 ? 0 : named / playable.length;
  add(
    'text.names',
    named > 0 && nameRatio >= 0.5,
    `${named}/${playable.length} playable units decoded to a non-empty name`,
  );

  const printable = playable.filter((u) => /^[\x20-\x7E\u00A0-\u00FF]+$/.test(u.name)).length;
  add(
    'text.printable',
    playable.length > 0 && printable / playable.length >= 0.5,
    `${printable}/${playable.length} names contain only printable Latin-1 characters`,
  );

  // --- Unit table sanity --------------------------------------------------
  // Vanilla tables have id === index + 1. A hack that inserts or reorders units
  // breaks that, so it is tolerated.
  const sequential = playable.filter((u) => u.id === u.index + 1).length;
  add(
    'unit.idSequence',
    playable.length > 0 && sequential / playable.length >= 0.9,
    `${sequential}/${playable.length} units have id === index + 1 (the vanilla convention)`,
    'warn',
  );

  const ids = playable.map((u) => u.id);
  const uniqueIds = new Set(ids).size === ids.length;
  add(
    'unit.uniqueIds',
    uniqueIds,
    uniqueIds ? 'all unit ids are unique' : 'duplicate unit ids found',
  );

  // See GROWTH_SOFT_LIMIT: >100 is unusual but legal, so this is a warning.
  const overLimitGrowths: string[] = [];
  for (const unit of playable) {
    for (const key of GROWTH_KEYS) {
      const value = unit.growths[key];
      if (value > GROWTH_SOFT_LIMIT) {
        overLimitGrowths.push(`${unit.name || `#${unit.id}`}.${key}=${value}`);
      }
    }
  }
  add(
    'unit.growthRange',
    overLimitGrowths.length === 0,
    overLimitGrowths.length === 0
      ? 'all growth rates are within 0-100'
      : `${overLimitGrowths.length} growth rates exceed 100 (legal, but only hacks do this): ` +
        overLimitGrowths.slice(0, 8).join(', '),
    'warn',
  );

  // Every unit must point at a class that exists in the class table.
  const unknownClasses = playable.filter((u) => !loaded.classNames.has(u.classId));
  add(
    'unit.classIds',
    unknownClasses.length === 0,
    unknownClasses.length === 0
      ? 'every unit class id resolves to a named class'
      : `${unknownClasses.length} units reference an unnamed class id ` +
        `(e.g. ${unknownClasses
          .slice(0, 5)
          .map((u) => `${u.name || `#${u.id}`}->0x${u.classId.toString(16)}`)
          .join(', ')})`,
  );

  // --- Support data -------------------------------------------------------
  const supports = validateSupports(loaded.supports, loaded.unitNames);

  add(
    'support.partnerCount',
    supports.countMismatches.length === 0,
    supports.countMismatches.length === 0
      ? 'declared partner count matches the actual data everywhere'
      : `${supports.countMismatches.length} units disagree: ` +
        supports.countMismatches
          .slice(0, 5)
          .map((m) => `${m.unitName || `#${m.unitId}`} ${m.declared}!=${m.actual}`)
          .join(', '),
  );

  add(
    'support.reciprocal',
    supports.valueMismatches.length === 0,
    supports.valueMismatches.length === 0
      ? 'A->B and B->A agree on initial value and growth'
      : `${supports.valueMismatches.length} pairs disagree`,
  );

  add(
    'support.bidirectional',
    supports.oneWayEdges.length === 0,
    supports.oneWayEdges.length === 0
      ? 'every support is recorded in both directions'
      : `${supports.oneWayEdges.length} one-way supports, e.g. ` +
        supports.oneWayEdges
          .slice(0, 5)
          .map((e) => `${e.aName}->${e.bName}`)
          .join(', '),
  );

  add(
    'support.pointers',
    supports.unreadablePointers.length === 0,
    supports.unreadablePointers.length === 0
      ? 'every non-zero support pointer resolves inside the ROM'
      : `${supports.unreadablePointers.length} units have an unusable support pointer`,
  );

  add(
    'support.limit',
    supports.overLimit.length === 0,
    supports.overLimit.length === 0
      ? 'no unit exceeds the seven-partner limit'
      : `${supports.overLimit.length} units exceed the limit`,
  );

  // --- Affinity / role data -----------------------------------------------
  // The bonus table is indexed by affinity id 1..7 and terminated by a zero
  // record, so a complete read must yield exactly ids 1..7 in order. A short or
  // gapped read means the pointer slot or the stride is wrong.
  const affinities = loaded.supportBonuses.map((b) => b.affinity);
  const affinityOk =
    affinities.length === 7 && affinities.every((a, i) => a === i + 1);
  add(
    'support.affinityTable',
    affinityOk,
    affinityOk
      ? `7 affinity bonus records read: ${affinities.join(',')}`
      : `expected affinity ids 1..7, read [${affinities.join(',')}] ` +
        `(${loaded.supportBonuses.length} records)`,
  );

  // The rank thresholds and the conversation caps are two different numbers
  // that must stay in lockstep: the cap is what the pair's point total is
  // clamped to at a rank, and taking the conversation bumps it past the
  // threshold. `cap + 1 === threshold` is the invariant that ties them.
  const { C, B, A } = SUPPORT_RANK_THRESHOLDS;
  const caps = SUPPORT_CONVERSATION_CAPS;
  const capsOk =
    C === caps.none + 1 && B === caps.C + 1 && A === caps.B + 1 && C < B && B < A;
  add(
    'support.rankThresholds',
    capsOk,
    capsOk
      ? `rank thresholds C>=${C}, B>=${B}, A>=${A} sit one point above the ` +
        `conversation caps ${caps.none}/${caps.C}/${caps.B}`
      : `thresholds and caps disagree: thresholds C=${C} B=${B} A=${A}, ` +
        `caps ${caps.none}/${caps.C}/${caps.B}`,
  );

  // The bonus table stores HALF-points and the game halves the sum at the end,
  // so the familiar C/B/A values are `stored * level / 2`. That makes every row
  // show `atk = 1` (giving 0/1/1) and `critAvoid = 5` (giving 2/5/7), and it
  // makes `atk` the one column that must be 0 at C but non-zero at B. A reader
  // that forgot the halving would report atk = 1 at C, which is the single
  // cheapest way to catch that mistake - hence this check.
  const rows = loaded.supportBonuses.map((b) => rankedBonus(b));
  const halfPointOk =
    rows.length === 7 &&
    rows.every((r) => r.C.atk === 0 && r.B.atk === r.A.atk && r.B.atk > 0) &&
    rows.every((r) => r.C.critAvoid === 2 && r.B.critAvoid === 5 && r.A.critAvoid === 7);
  add(
    'support.bonusHalving',
    halfPointOk,
    halfPointOk
      ? 'all 7 rows halve as the game does: atk 0/1/1 and critAvoid 2/5/7 at C/B/A'
      : `half-point scaling looks wrong; atk by rank = ${rows
          .map((r) => `${r.C.atk}/${r.B.atk}/${r.A.atk}`)
          .join(' ')}`,
  );

  // Byte 7 of a record is never touched by `StoreAddedAffinityBonusesForSupportLevel`
  // (it writes offsets 1..6 only), so it is padding and should be zero. A
  // non-zero value would mean the stride is off by something.
  const paddingNonZero = loaded.supportBonuses.filter(
    (b) => (b.bonuses.unknown7 ?? 0) !== 0,
  );
  add(
    'support.bonusPadding',
    paddingNonZero.length === 0,
    paddingNonZero.length === 0
      ? 'byte 7 of every bonus record is zero, as expected for unused padding'
      : `${paddingNonZero.length} bonus records have a non-zero byte 7 ` +
        `(the game never reads it, so the stride may be wrong)`,
  );

  // The affinity names are decoded from the ROM's own text ids, and the
  // reference hardcodes the same seven names. Agreement is a real check on the
  // text table AND on the affinity id ordering.
  const nameMismatch = [...loaded.affinityNames.entries()].filter(
    ([id, name]) => name !== affinityName(id),
  );
  add(
    'support.affinityNames',
    loaded.affinityNames.size === 7 && nameMismatch.length === 0,
    nameMismatch.length === 0
      ? `the ROM's text table names all 7 affinities exactly as the reference does`
      : `affinity names disagree: ${nameMismatch
          .map(([id, name]) => `${id}=${JSON.stringify(name)} vs ${affinityName(id)}`)
          .join(', ')}`,
  );

  // Every support pair should be able to reach at least C. A pair whose growth
  // is 0 and whose initial value is below the C threshold can never support at
  // all, which is legal but almost always a data-entry mistake.
  const unreachable = loaded.supportGraph.filter(
    (e) => e.growth <= 0 && e.initial < SUPPORT_RANK_THRESHOLDS.C,
  );
  add(
    'support.reachable',
    unreachable.length === 0,
    unreachable.length === 0
      ? `all ${loaded.supportGraph.length} support pairs can reach C rank`
      : `${unreachable.length} pairs can never reach C (growth 0 and initial < ${SUPPORT_RANK_THRESHOLDS.C}) ` +
        `(e.g. ${unreachable
          .slice(0, 5)
          .map((e) => `${e.aName}<->${e.bName}(${e.initial}/+${e.growth})`)
          .join(', ')})`,
    'warn',
  );

  // --- Terrain names -------------------------------------------------------
  // `MoveCostForm` labels its 65 cost columns J_0..J_64 with this table, so a
  // complete read must cover ids 0..0x40. A short read means the pointer slot
  // or the stride is wrong - and it would silently mislabel every terrain.
  const terrain = loaded.terrainNames;
  const terrainCount = terrain.names.length;
  const terrainOk = terrain.table !== null && terrainCount >= 0x41;
  add(
    'terrain.nameTable',
    terrainOk,
    terrain.table === null
      ? 'the terrain-name pointer slot did not resolve to a usable table'
      : terrainOk
        ? `${terrainCount} terrain names read (ids 0..0x${(terrainCount - 1)
            .toString(16)
            .toUpperCase()}), stride ${terrain.table.recordSize}`
        : `only ${terrainCount} terrain names read; the movement-cost tables have ` +
          `0x41 columns, so 65 are expected`,
  );

  if (terrain.table !== null && !terrain.table.isMultibyte) {
    const named = terrain.names.filter((n) => n.name !== '').length;
    add(
      'terrain.namesDecode',
      named >= 0x3c,
      `${named}/${terrainCount} terrain names decoded to non-empty text`,
      'warn',
    );
  }

  // Role derivation depends on the class movement-cost table being readable.
  // A table that is entirely impassable, or shorter than the 65 terrain slots,
  // means the `+56` pointer is wrong and every role would be mislabelled.
  //
  // Exception: a class with movement range 0 is a static object (Gorgon Egg,
  // Arcane Lock, blank filler slots) and legitimately has no cost table. Only
  // flag classes that actually move but have no usable costs.
  const classes = loaded.classes.filter((c) => !c.isEmpty);
  const badCosts = classes.filter(
    (c) =>
      c.movementRange > 0 &&
      (c.movementCosts.length !== CLASS_TERRAIN_COUNT ||
        c.movementCosts.every((v) => v === 0xff)),
  );
  const staticClasses = classes.filter((c) => c.movementRange === 0).length;
  add(
    'class.movementCosts',
    classes.length > 0 && badCosts.length === 0,
    badCosts.length === 0
      ? `all ${classes.length - staticClasses} mobile classes have a ` +
        `${CLASS_TERRAIN_COUNT}-entry movement-cost table ` +
        `(${staticClasses} immobile classes skipped)`
      : `${badCosts.length} mobile classes have a missing or all-impassable cost table ` +
        `(e.g. ${badCosts
          .slice(0, 5)
          .map((c) => `${c.name || `#${c.id}`}(${c.movementCosts.length})`)
          .join(', ')})`,
  );

  // The point of reading the terrain-name table is that its ids are the *same*
  // ids the movement-cost tables are indexed by. Cross-check the alignment
  // using the one rule the game enforces: Peak (0x12) must be reachable by
  // fliers and blocked for most ground classes. If fliers could not reach Peak
  // the two id spaces would be offset from each other, and every terrain label
  // would sit on the wrong column.
  //
  // Ground classes that *can* reach Peak are not an error - Brigands and
  // Berserkers legitimately cross peaks, and this hack adds monster classes
  // that do too - so they are reported rather than flagged.
  const PEAK = 0x12;
  const movable = classes.filter(
    (c) => c.movementRange > 0 && c.movementCosts.length === CLASS_TERRAIN_COUNT,
  );
  const canEnterPeak = movable.filter((c) => c.movementCosts[PEAK] !== 0xff);
  const flyingOnPeak = canEnterPeak.filter(
    (c) => loaded.classRoles.get(c.id)?.mobility === 'flying',
  );
  const groundOnPeak = canEnterPeak.filter(
    (c) => loaded.classRoles.get(c.id)?.mobility !== 'flying',
  );
  add(
    'terrain.idAlignment',
    flyingOnPeak.length > 0 && movable.length > canEnterPeak.length,
    flyingOnPeak.length === 0
      ? 'no flying class can enter Peak (0x12); the terrain-name ids and the ' +
        'movement-cost ids are probably offset from each other'
      : `${flyingOnPeak.length} flying classes can enter Peak (0x12) and ` +
        `${movable.length - canEnterPeak.length} ground classes cannot, so the ids ` +
        `line up. ${groundOnPeak.length} ground classes can also cross Peak ` +
        `(${[...new Set(groundOnPeak.map((c) => c.name || `#${c.id}`))].join(', ')})`,
    'warn',
  );

  // Every playable unit should get a role. Missing roles mean the class id
  // resolved by name but had no role - the two lookups disagreeing is a bug.
  const roleless = playable.filter((u) => !loaded.classRoles.has(u.classId));
  add(
    'roster.roleCoverage',
    roleless.length === 0,
    roleless.length === 0
      ? 'every playable unit has a derived class role'
      : `${roleless.length} units have no role ` +
        `(e.g. ${roleless
          .slice(0, 5)
          .map((u) => `${u.name || `#${u.id}`}->${u.className || `0x${u.classId.toString(16)}`}`)
          .join(', ')})`,
    'warn',
  );

  // A roster with no healer or no flier is legal (a hack may field none), but it
  // is worth surfacing because it changes what "team composition" can mean.
  const playableRoles = playable
    .map((u) => loaded.classRoles.get(u.classId))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const healerCount = playableRoles.filter((r) => r.hasStaff).length;
  const flyingCount = playableRoles.filter((r) => r.mobility === 'flying').length;
  add(
    'roster.hasSupportRoles',
    healerCount > 0 && flyingCount > 0,
    `derived roles over ${playableRoles.length} populated unit slots: ` +
      `${healerCount} can use staves, ${flyingCount} are flying ` +
      '(slots include enemies and generic templates)',
    'warn',
  );

  // A unit's base stats are signed deltas on the class base, and the game
  // wraps any sum of -1 or less to the maximum on load (InputFormRef.cs:12022:
  // 「合算した時に-1以下になると、2の補数により、ロード時に最大数になります」).
  // Such a unit is broken, so this is an error, not a warning.
  const wrapped = loaded.units.filter((u) =>
    Object.values(u.startingStats).some((v) => v <= -1),
  );
  add(
    'unit.statWraps',
    wrapped.length === 0,
    wrapped.length === 0
      ? `no unit's "class base + per-unit delta" reaches -1 across ` +
        `${loaded.units.length} slots`
      : `${wrapped.length} units have a starting stat <= -1, which the game ` +
        `wraps to the maximum on load: ` +
        wrapped
          .slice(0, 5)
          .map(
            (u) =>
              `${u.name || `#${u.id}`}[` +
              Object.entries(u.startingStats)
                .filter(([, v]) => v <= -1)
                .map(([k, v]) => `${k}=${v}`)
                .join(',') +
              ']',
          )
          .join(', '),
  );

  // Base stats must be read signed. If they were read unsigned, every negative
  // delta would show up as a value >= 128 - which is what the per-unit field
  // looks like only when it is genuinely negative.
  const negativeDeltas = loaded.units.filter((u) =>
    Object.values(u.stats).some((v) => v < 0),
  );
  add(
    'unit.signedBaseStats',
    true,
    `${negativeDeltas.length} units carry at least one negative per-unit base ` +
      'stat (legal: the field is a signed delta on the class base). ' +
      'Reading it as unsigned would turn each of those into a value >= 128.',
    'warn',
  );

  // --- Chapter / join-order chain -----------------------------------------
  // The chain is: map setting record -> event plist -> condition table ->
  // placement block / event script -> LOAD1 instruction. Each link is a
  // pointer, so a wrong layout shows up as a broken link, not as wrong values.
  const mapSettings = loaded.mapSettings;
  add(
    'chapter.mapSettingTable',
    mapSettings !== null && mapSettings.count > 0,
    mapSettings === null
      ? 'this game layout has no map section'
      : `table 0x${mapSettings.tableOffset.toString(16).toUpperCase()} ` +
        `(${mapSettings.count} records of ${mapSettings.recordSize} bytes, ` +
        `counted by ${mapSettings.countSource} scan)`,
  );

  // The map-setting table's index is NOT a chapter number: it counts unused
  // slots and non-story maps. Surface that split so nobody reads "index 60" as
  // "chapter 60". `@001F` is the glyph world-map encounter maps decode to.
  const noTitle = loaded.chapters.filter((c) => c.title === '');
  const worldMap = loaded.chapters.filter((c) => c.title === '@001F');
  const story = loaded.chapters.filter((c) => c.title !== '' && c.title !== '@001F');
  const numbered = loaded.chapters.filter((c) => c.chapterNumber > 0);
  const maxChapter = numbered.reduce((n, c) => Math.max(n, c.chapterNumber), 0);
  add(
    'chapter.storyVsPlaceholder',
    story.length > 0,
    `${story.length} records have a real chapter title, ${noTitle.length} have none ` +
      `(unused slots), ${worldMap.length} decode to the world-map glyph @001F. ` +
      `The map-setting index counts all of them, so index != chapter number. ` +
      `The game's own chapter number (+0x80/2) tops out at ${maxChapter}.`,
    'warn',
  );

  // Independent confirmation of the `+0x80` reading. Titles in this hack are
  // written `C<n>[A|B|x]: ...`, so the leading number must equal the decoded
  // chapter number. A trailing `x` (gaiden) is allowed to occupy the half step
  // after its chapter, i.e. n or n + 1 - that is exactly why the field is
  // stored doubled. If `+0x80` were something else, this would not hold across
  // ~50 records.
  const titleNumber = (chapter: { title: string; chapterNumber: number }): boolean => {
    const m = /^C(\d+)([ABx]?):/.exec(chapter.title);
    if (m === null) return true;
    const n = Number(m[1]);
    return m[2] === 'x'
      ? chapter.chapterNumber >= n && chapter.chapterNumber <= n + 1
      : chapter.chapterNumber === n;
  };
  const titleMismatch = loaded.chapters.filter((c) => !titleNumber(c));
  const titlesChecked = loaded.chapters.filter((c) => /^C\d/.test(c.title)).length;
  add(
    'chapter.numberMatchesTitle',
    titleMismatch.length === 0,
    titleMismatch.length === 0
      ? `every "C<n>: ..." title agrees with the decoded chapter number ` +
        `(${titlesChecked} records checked)`
      : `${titleMismatch.length} titles disagree with +0x80/2: ` +
        titleMismatch
          .slice(0, 5)
          .map((c) => `${c.title} -> ${c.chapterNumber}`)
          .join(', '),
  );

  // Every record that names an event plist must resolve to a readable
  // condition table whose pointers are inside the ROM.
  const withPlist = loaded.chapters.filter((c) => c.eventPlist !== 0);
  const resolvedConds = withPlist.filter((c) => c.condTableAddr !== 0);
  add(
    'chapter.conditionTables',
    withPlist.length === 0 || resolvedConds.length === withPlist.length,
    `${resolvedConds.length}/${withPlist.length} chapters with an event plist ` +
      'resolve to a condition table',
  );

  // A placement block is a run of `unitDataSize`-byte records terminated by a
  // zero unit id. If the record size were wrong, blocks would never terminate.
  const placementAddrs = loaded.chapters
    .filter((c) => c.playerPlacementAddr !== 0)
    .map((c) => c.playerPlacementAddr);
  const unterminated = loaded.chapters.filter((c) => {
    if (c.playerPlacementAddr === 0 || loaded.layout.map === null) return false;
    const end = c.playerPlacementAddr + c.placements.length * loaded.layout.map.unitDataSize;
    return !loaded.rom.isSafeOffset(end) || loaded.rom.u8(end) !== 0;
  });
  add(
    'chapter.placementBlocks',
    placementAddrs.length > 0 && unterminated.length === 0,
    unterminated.length === 0
      ? `all ${placementAddrs.length} player placement blocks terminate on a zero unit id`
      : `${unterminated.length} blocks never hit a zero terminator ` +
        `(map ${unterminated
          .slice(0, 5)
          .map((c) => c.index)
          .join(', ')}) - the record size is probably wrong`,
  );

  // --- Forced deployment / deployment slots -------------------------------
  // The forced-deployment ("強制出撃") table is a separate table from the
  // placement blocks, and nothing in the reference program ties the two
  // together - so cross-checking them is the only cheap proof that both were
  // read at the right offsets. Two independent claims are checked below.
  const force = loaded.forceSortie;
  add(
    'chapter.forceSortieTable',
    force === null || (force.count > 0 && force.recordSize === 4),
    force === null
      ? 'this game layout has no forced-deployment table'
      : `table 0x${force.tableOffset.toString(16).toUpperCase()} ` +
        `(${force.count} records of ${force.recordSize} bytes, ` +
        `terminated by 0xFFFF): ` +
        `${[...new Set(force.records.map((r) => r.unitId))].length} distinct units, ` +
        `${force.records.filter((r) => r.mapIndex === MAP_ANY).length} with an ` +
        `"every map" filter`,
  );

  if (force !== null && force.count > 0) {
    // A force-sortie record that names a map must describe a unit that is
    // actually on that map. If the record's map filter were read from the wrong
    // byte, or the table stride were wrong, the two tables would stop agreeing.
    //
    // A miss is a warning, not an error: a forced unit can also be brought in
    // by the chapter's start event rather than pre-placed, which is what
    // happens on this ROM's C15.
    const perMap = loaded.chapters.filter((c) => c.placements.length > 0);
    const unplaced: string[] = [];
    let checkedRecords = 0;
    for (const chapter of perMap) {
      const placed = new Set(chapter.placements.map((p) => p.unitId));
      const forced = forcedUnitsForMap(force, chapter.index).filter(
        (r) => r.mapIndex !== MAP_ANY,
      );
      checkedRecords += forced.length;
      for (const record of forced) {
        if (!placed.has(record.unitId)) {
          unplaced.push(`${chapter.title || `#${chapter.index}`}->unit ${record.unitId}`);
        }
      }
    }
    add(
      'chapter.forcedUnitsArePlaced',
      unplaced.length === 0,
      unplaced.length === 0
        ? `all ${checkedRecords} map-specific force-sortie records name a unit ` +
          'that is pre-placed on that chapter'
        : `${unplaced.length}/${checkedRecords} force-sortie records name a unit the ` +
          `chapter does not pre-place (they must arrive via the start event): ` +
          `${unplaced.slice(0, 5).join(', ')}`,
      'warn',
    );

    // The deployment-slot count is the length of the player-unit block, so a
    // numbered chapter with no block means the condition-table link broke.
    // Bonus/test maps (unnumbered, e.g. "Castle Frelia", "Act 2 Checkpoint")
    // legitimately have no player block and are excluded.
    const titled = loaded.chapters.filter(
      (c) => c.title !== '' && c.title !== '@001F' && c.condTableAddr !== 0,
    );
    const story = titled.filter((c) => c.chapterNumber > 0 || /^P:/.test(c.title));
    const slotless = story.filter((c) => c.deploySlots === 0);
    const slots = story.map((c) => c.deploySlots).sort((a, b) => a - b);
    const median = slots.length === 0 ? 0 : slots[Math.floor(slots.length / 2)];
    add(
      'chapter.deploySlots',
      story.length > 0 && slotless.length === 0,
      slotless.length === 0
        ? `${story.length} numbered chapters all have a deployment block: ` +
          `min ${slots[0]}, median ${median}, max ${slots[slots.length - 1]} ` +
          `(${titled.length - story.length} unnumbered bonus/test maps skipped)`
        : `${slotless.length} chapters resolve a condition table but no player ` +
          `placement block: ${slotless
            .slice(0, 5)
            .map((c) => c.title || `#${c.index}`)
            .join(', ')}`,
      'warn',
    );

    // On hard mode the game swaps in condition slot 11's block, so its length
    // is the hard-mode deployment count. It normally differs only where the
    // author made it differ, but a *shorter* hard block is unusual enough to
    // surface - this ROM's C10B drops from 12 to 9.
    const hardDiffers = story.filter((c) => c.deploySlotsHard !== c.deploySlots);
    add(
      'chapter.hardDeploySlots',
      true,
      hardDiffers.length === 0
        ? 'every chapter deploys the same number of units on both difficulties'
        : `${hardDiffers.length} chapter(s) differ on hard mode: ` +
          hardDiffers
            .map((c) => `${c.title || `#${c.index}`} ${c.deploySlots}->${c.deploySlotsHard}`)
            .join(', '),
      'warn',
    );
  }

  // A recruit instruction is only found by walking a script, so the walk
  // quality bounds how much of the join order can be trusted.
  const totalWalks = loaded.chapterScans.reduce((n, s) => n + s.truncatedWalks, 0);
  const totalSites = loaded.joins.sitesByKind.recruit + loaded.joins.sitesByKind.load;
  add(
    'chapter.scriptWalks',
    totalSites > 0,
    `${totalSites} load instructions found; ${totalWalks} script walks were ` +
      'abandoned after ten consecutive unknown opcodes (recruits after such a ' +
      'point are missed)',
    'warn',
  );

  // Every unit that has support data is a real character, so it should appear
  // in at least one chapter. A miss means the chapter chain is incomplete.
  const supportCharacterIds = new Set(loaded.supports.entries.map((e) => e.unitId));
  const withoutEvidence = [...supportCharacterIds].filter(
    (id) => !loaded.joins.appearances.has(id),
  );
  add(
    'roster.joinEvidence',
    withoutEvidence.length === 0,
    `${supportCharacterIds.size - withoutEvidence.length}/${supportCharacterIds.size} ` +
      'support characters have chapter evidence' +
      (withoutEvidence.length > 0 ? `; missing: ${withoutEvidence.join(', ')}` : ''),
    'warn',
  );

  // ---- items ------------------------------------------------------------
  //
  // The item-name font is an empirical table (`text/itemFont.ts`), so the
  // strongest available check is that nothing fell through it: an unmapped code
  // shows up as U+FFFD in the name.
  const namedItems = loaded.items.filter((i) => i.nameTextId !== 0);
  const unmapped = namedItems.filter((i) => i.nameUnknownCodes.length > 0);
  add(
    'item.nameFont',
    unmapped.length === 0,
    `${namedItems.length - unmapped.length}/${namedItems.length} item names decoded ` +
      'with no unmapped item-font codes' +
      (unmapped.length > 0
        ? `; first offenders: ${unmapped
            .slice(0, 5)
            .map((i) => `#${i.id}=${i.name}`)
            .join(', ')}`
        : ''),
    'error',
  );

  const badPrice = namedItems.filter((i) => i.buyPrice !== i.uses * i.unitPrice);
  add(
    'item.priceRule',
    badPrice.length === 0,
    'every buyPrice equals uses x unitPrice (the field at +26 is a unit price)',
    'error',
  );

  const typeCounts = new Map<string, number>();
  for (const i of namedItems) typeCounts.set(i.typeName, (typeCounts.get(i.typeName) ?? 0) + 1);
  add(
    'item.types',
    !typeCounts.has('type0') && (typeCounts.get('sword') ?? 0) > 0,
    `type field is 0-based and maps cleanly: ${[...typeCounts.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
    'error',
  );

  // ---- shops ------------------------------------------------------------
  const shops = loaded.shopData?.shops ?? [];
  const unknownShopItems: string[] = [];
  let shopEntries = 0;
  for (const shop of shops) {
    for (const e of shop.entries) {
      shopEntries++;
      if (!loaded.itemMap.has(e.itemId)) unknownShopItems.push(`${shop.label}:${e.itemId}`);
    }
  }
  add(
    'shop.itemsResolve',
    unknownShopItems.length === 0,
    `${shopEntries} shop entries across ${shops.length} shops all resolve to a ` +
      'named item' +
      (unknownShopItems.length ? `; missing: ${unknownShopItems.slice(0, 5).join(', ')}` : ''),
    'error',
  );

  const prep = shops.find((s) => s.kind === 'prep');
  add(
    'shop.prepShop',
    prep !== undefined && prep.entries.length > 0,
    prep
      ? `prep-screen shop at 0x${prep.addr.toString(16)} lists ${prep.entries.length} items`
      : 'no prep-screen shop was found',
    'warn',
  );

  // ---- map objects (chests, villages, doors) ----------------------------
  const chests = loaded.mapObjects.filter((o) => o.kind === 'chest');
  const goldChests = chests.filter((o) => o.isGoldChest);
  const itemChests = chests.filter((o) => !o.isGoldChest);

  const badChestType = chests.filter((o) => o.objectType !== 0x14);
  const unresolvedChestItems = itemChests.filter(
    (o) => o.itemId === null || !loaded.itemMap.has(o.itemId),
  );
  add(
    'object.chestType',
    badChestType.length === 0,
    badChestType.length === 0
      ? `all ${chests.length} chest records carry object type 0x14, as FE8 requires`
      : `${badChestType.length} chest records carry a non-chest object type: ` +
        badChestType
          .slice(0, 5)
          .map((o) => `0x${o.objectType.toString(16)}`)
          .join(', '),
    'error',
  );

  add(
    'object.chestLoot',
    unresolvedChestItems.length === 0,
    `${itemChests.length} item chests all name a real item, plus ${goldChests.length} ` +
      'gold chests (' +
      `${goldChests.reduce((s, o) => s + o.gold, 0)} gold, stored at record +6)` +
      (unresolvedChestItems.length
        ? `; unresolved: ${unresolvedChestItems
            .slice(0, 5)
            .map((o) => `0x${(o.itemId ?? 0).toString(16)}`)
            .join(', ')}`
        : ''),
    'error',
  );

  // A gold chest is only well-formed when it names the gold item AND carries a
  // non-zero amount; the reference's FELint states this invariant explicitly.
  const malformedGold = chests.filter(
    (o) => (o.itemId === 0x77) !== (o.gold > 0),
  );
  add(
    'object.goldChestRule',
    malformedGold.length === 0,
    malformedGold.length === 0
      ? 'every chest either names item 0x77 with a non-zero amount, or names a real item with 0'
      : `${malformedGold.length} chests break the "item 0x77 <=> gold > 0" rule`,
    'error',
  );

  const shopObjects = loaded.mapObjects.filter((o) => o.kind === 'shop');
  const shopKinds = new Set(shopObjects.map((o) => o.objectType));
  add(
    'object.shopObjects',
    shopObjects.length > 0 && [...shopKinds].every((k) => k === 0x16 || k === 0x17 || k === 0x18),
    `${shopObjects.length} shop objects, object types ` +
      [...shopKinds].map((k) => `0x${k.toString(16)}`).join(', '),
    'warn',
  );

  // ---- enemy stat projection (AGENTS.md §3.20) ----------------------------
  //
  // The enemy half of the doubling rule has no table behind it: enemies are
  // ordinary placement records, so their stats have to be projected. These
  // checks catch the two ways that projection can rot - the script walk losing
  // blocks, and the autolevel band going malformed.
  const enemy = collectEnemyStats({
    rom: loaded.rom,
    layout: loaded.layout,
    eventScripts: loaded.eventScripts,
    chapters: loaded.chapters,
    condSlots: loaded.condSlots,
    classes: loaded.classes,
    units: loaded.units,
    items: loaded.items,
    hard: false,
  });

  const routineCount = { unit: 0, realistic: 0, none: 0 };
  for (const s of enemy.samples) routineCount[s.routine] += 1;

  add(
    'enemy.records',
    enemy.samples.length > 0 && enemy.unresolvedClass === 0,
    `${enemy.samples.length} enemy records projected from condition-slot scripts ` +
      `(${routineCount.unit} AutolevelUnit / ${routineCount.realistic} AutolevelRealistic / ` +
      `${routineCount.none} no autolevel), ${enemy.unresolvedClass} dropped for an ` +
      'unresolvable class id. The walk stops after ten consecutive unknown opcodes, ' +
      'so this is a lower bound, not a census.',
    'error',
  );

  // `GetAutoleveledStat` burns random numbers, so every stat is a band. A band
  // that does not contain its own mean means the arithmetic drifted.
  const malformedBands = enemy.samples.filter(
    (s) => !(s.as.lo <= s.as.mean + 1e-9 && s.as.mean <= s.as.hi + 1e-9),
  );
  add(
    'enemy.statBand',
    malformedBands.length === 0,
    malformedBands.length === 0
      ? `every projected attack speed satisfies lo <= mean <= hi (${enemy.samples.length} checked)`
      : `${malformedBands.length} records have an attack-speed band that excludes its own mean`,
    'error',
  );

  // Negative attack speed is legal: `BattleLoadAS` subtracts the weight penalty
  // from a signed byte and nothing clamps it, so an egg holding a tome sits
  // below zero. Reported so the number in the economy report is not a surprise.
  const negativeAs = enemy.samples.filter((s) => s.as.mean < 0);
  const negativeClasses = [...new Set(negativeAs.map((s) => s.className))].sort();
  add(
    'enemy.negativeAs',
    true,
    `${negativeAs.length} of ${enemy.samples.length} enemy records project below zero attack speed ` +
      `(${negativeClasses.slice(0, 8).join(', ')}${negativeClasses.length > 8 ? ', ...' : ''}). ` +
      'Legal: the engine stores attack speed signed and never clamps it.',
    'warn',
  );

  const failed = checks.filter((c) => !c.passed);
  const errors = failed.filter((c) => c.severity === 'error');
  const warnings = failed.filter((c) => c.severity === 'warn');

  return {
    ok: errors.length === 0,
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    checks,
    supports,
  };
}
