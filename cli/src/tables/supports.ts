/**
 * Support relationships.
 *
 * ## How this table is indexed
 *
 * There is **no** usable index for the support table. It is not ordered by unit
 * id and has no fixed length. The only way in is the support pointer stored at
 * **offset +44 of each unit record**:
 *
 *     unitAddress + 44 -> GBA pointer -> 24-byte support record
 *
 * (`SupportUnitForm.cs:282` notes this +44 convention is shared by FE6/FE7/FE8.)
 *
 * Records happen to be packed back to back at a 24-byte stride in
 * `dream-of-five.gba` (verified: 62 records, 61 gaps, all 0x18), but **do not
 * rely on that** - nothing guarantees the ordering, and unit id order does not
 * match address order there (unit 1 -> 0x1AEF610, unit 2 -> 0x1AEF640,
 * unit 3 -> 0x1AEF670, unit 4 -> 0x1AEF658). Indexing by stride is only safe
 * after you have confirmed the layout on the specific ROM.
 *
 * ## Record layout, 24 bytes
 *
 *   +0..6   u8 x7  partner unit ids   (0 = empty slot)
 *   +7..13  u8 x7  initial support value per partner
 *   +14..20 u8 x7  support growth per partner
 *   +21     u8     declared partner count
 *   +22..23 u8 x2  padding
 *
 * Bindings confirmed in `SupportUnitForm.cs`: partner *i* is `B{i}`, its
 * initial value is `B{7+i}`, its growth is `B{14+i}`, and the count is `B21`.
 *
 * ## Two things that bite
 *
 * 1. **Supports are stored twice.** A→B and B→A are separate records and both
 *    must agree. Deduplicate before building a graph or every edge doubles.
 * 2. **Trailing slots hold stale data.** Only entries whose partner id is
 *    non-zero are meaningful; values beyond that are leftovers from whoever
 *    authored the table and must be ignored.
 *
 * Reference: FEBuilderGBA/FEBuilderGBA/SupportUnitForm.cs
 */

import { RomBuffer } from '../rom/RomBuffer.ts';
import type { Unit } from './units.ts';
import { unitNameOrId } from './units.ts';

export const SUPPORT_RECORD_SIZE = 24;

/** The ROM stores at most seven partners per unit. `SupportUnitForm.cs:322`. */
export const SUPPORT_LIMIT = 7;

/**
 * Support-point totals that define the three ranks.
 *
 * Transcribed verbatim from the explanation box the reference ships on the
 * support editor (`SupportUnitForm.Designer.cs:460`, and the identical
 * `SupportUnitFE6Form.Designer.cs:363`):
 *
 *     C    81から160まで
 *     B    161から240まで
 *     A    241以降
 *
 *     支援の値は、初期値から始まり、キャラが隣接していると進行度に応じて増加していきます。
 *     一定数の支援値がたまると、支援コマンドが表示され、支援会話をすることで次のレベルに進みます。
 *
 * i.e. the *displayed* support value is 81..160 at C, 161..240 at B and 241+ at
 * A. These are cumulative totals, not per-rank deltas - reaching B needs 161
 * points in total, not 81 + 161.
 *
 * Independently confirmed twice over. The ROM's own `GetSupportLevelBySupportIndex`
 * (file offset 0x2823C) hardcodes `> 0xF0 -> A, > 0xA0 -> B, > 0x50 -> C`, and
 * the FE8 decomp names the same numbers `SUPPORT_EXP_C = 81 / B = 161 / A = 241`
 * in `include/bmreliance.h`.
 *
 * Note these are the values a pair *holds* once a rank is reached; the point at
 * which the rank's conversation unlocks is one lower - see
 * {@link SUPPORT_CONVERSATION_CAPS}.
 */
export const SUPPORT_RANK_THRESHOLDS = { C: 81, B: 161, A: 241 } as const;

export type SupportRank = 'none' | 'C' | 'B' | 'A';

/** Highest rank whose threshold `points` already meets. */
export function supportRankFor(points: number): SupportRank {
  if (points >= SUPPORT_RANK_THRESHOLDS.A) return 'A';
  if (points >= SUPPORT_RANK_THRESHOLDS.B) return 'B';
  if (points >= SUPPORT_RANK_THRESHOLDS.C) return 'C';
  return 'none';
}

/**
 * Support points at which each rank's **support conversation** becomes
 * available.
 *
 * These are `SUPPORT_EXP_C-1 / SUPPORT_EXP_B-1 / SUPPORT_EXP_A-1` from the FE8
 * decomp's `sSupportMaxExpLookup` (`src/bmreliance.c`):
 *
 *     [SUPPORT_LEVEL_NONE] = SUPPORT_EXP_C-1,   // 80
 *     [SUPPORT_LEVEL_C]    = SUPPORT_EXP_B-1,   // 160
 *     [SUPPORT_LEVEL_B]    = SUPPORT_EXP_A-1,   // 240
 *     [SUPPORT_LEVEL_A]    = SUPPORT_EXP_A      // 241
 *
 * `UnitGainSupportExp` clamps the pair's total to the cap for its *current*
 * rank, and `CanUnitSupportNow` unlocks the conversation only once the total
 * sits exactly on that cap. So points accumulate 0 -> 80, then the player talks
 * and `UnitGainSupportLevel` bumps the total to 81, and so on. The cap is the
 * gate; {@link SUPPORT_RANK_THRESHOLDS} is the value you hold afterwards.
 */
export const SUPPORT_CONVERSATION_CAPS = { none: 80, C: 160, B: 240 } as const;

/**
 * The support-point total a pair holds immediately after each conversation.
 * `UnitGainSupportLevel` does a bare `unit->supports[num]++` on top of the cap.
 */
export const SUPPORT_POST_CONVERSATION = { C: 81, B: 161, A: 241 } as const;

export interface SupportRankPlan {
  /** Rank the pair already has at chapter 1, from its initial support value. */
  startingRank: SupportRank;
  /**
   * Turns the pair must spend adjacent before each support conversation becomes
   * available, *given that the previous conversations were taken as soon as
   * they appeared*. `null` when the growth rate is 0 and the cap is not yet
   * reached. Talking costs no turns, so these are also the marginal turn costs.
   */
  turnsToConversation: Record<Exclude<SupportRank, 'none'>, number | null>;
  /**
   * Cumulative turns spent adjacent before the pair's support value *reaches*
   * each rank - i.e. the sum of the conversation waits up to and including that
   * rank. This is a lower bound: it assumes every conversation is triggered the
   * moment it unlocks.
   */
  turnsTo: Record<Exclude<SupportRank, 'none'>, number | null>;
}

/** Turns of adjacency needed to accumulate `target` points from `initial`. */
function turnsFor(initial: number, growth: number, target: number): number | null {
  if (initial >= target) return 0;
  if (growth <= 0) return null;
  return Math.ceil((target - initial) / growth);
}

const RANKS = ['C', 'B', 'A'] as const;

/**
 * Plan how long a pair needs to spend adjacent to reach each rank.
 *
 * Walks the three gates in order, carrying the pair's running total forward:
 * a pair that starts at 0 with growth 3 needs 27 turns to hit the 80 cap
 * (`ceil(80/3)`), and after that conversation its total is 81, so B needs
 * another `ceil(79/3) = 27` turns, and A another 27 - 81 turns in total. Note
 * that is *not* `ceil(241/3) = 81` by coincidence here but will differ whenever
 * the growth rate does not divide the remainders evenly.
 */
export function supportRankPlan(initial: number, growth: number): SupportRankPlan {
  const startingRank = supportRankFor(initial);

  // Running state: where the pair's total sits now, and what it can grow to.
  let total = initial;
  let rank: SupportRank = startingRank;

  const turnsToConversation = {} as Record<
    Exclude<SupportRank, 'none'>,
    number | null
  >;
  const turnsTo = {} as Record<Exclude<SupportRank, 'none'>, number | null>;

  let cumulative: number | null = 0;

  for (const target of RANKS) {
    if (cumulative === null) {
      turnsToConversation[target] = null;
      turnsTo[target] = null;
      continue;
    }

    // Already at or past this rank? Then it costs nothing.
    const order = { none: 0, C: 1, B: 2, A: 3 } as const;
    if (order[rank] >= order[target]) {
      turnsToConversation[target] = 0;
      turnsTo[target] = cumulative;
      continue;
    }

    const cap = SUPPORT_CONVERSATION_CAPS[rank as keyof typeof SUPPORT_CONVERSATION_CAPS];
    const wait = turnsFor(total, growth, cap);
    turnsToConversation[target] = wait;
    if (wait === null) {
      cumulative = null;
      turnsTo[target] = null;
      continue;
    }

    cumulative += wait;
    turnsTo[target] = cumulative;
    // The conversation fires, so the pair's total jumps to the post-talk value.
    total = SUPPORT_POST_CONVERSATION[target];
    rank = target;
  }

  return { startingRank, turnsToConversation, turnsTo };
}

export const SUPPORT_OFFSET = {
  partners: 0,
  initialValues: 7,
  growthValues: 14,
  declaredCount: 21,
} as const;

export interface SupportPartner {
  /** Partner unit id, 1-based. */
  unitId: number;
  unitName: string;
  /** Support points the pair starts with. */
  initial: number;
  /** Support points gained per turn spent adjacent. */
  growth: number;
}

export interface SupportEntry {
  unitId: number;
  unitName: string;
  /** File offset of this unit's support record. */
  address: number;
  /** Partner count recorded at +21. */
  declaredCount: number;
  /** Number of slots holding a non-zero partner id. Should equal `declaredCount`. */
  actualCount: number;
  countMatches: boolean;
  partners: SupportPartner[];
}

export interface SupportGraphEdge {
  /** Unit ids, always ordered with `a < b`. */
  a: number;
  aName: string;
  b: number;
  bName: string;
  initial: number;
  growth: number;
  /** True when the reverse record exists and agrees on both numbers. */
  reciprocal: boolean;
  /** Set when the reverse record exists but disagrees. */
  mismatch?: { initial: number; growth: number };
}

export interface SupportReadResult {
  entries: SupportEntry[];
  /** Units whose +44 slot did not hold a usable pointer. */
  missing: { unitId: number; unitName: string; rawPointer: number }[];
}

function readRecord(
  rom: RomBuffer,
  address: number,
  nameMap: ReadonlyMap<number, string>,
): SupportEntry | null {
  if (!rom.isSafeOffset(address) || address + SUPPORT_RECORD_SIZE > rom.length) {
    return null;
  }

  const partners: SupportPartner[] = [];
  let actualCount = 0;

  for (let i = 0; i < SUPPORT_LIMIT; i++) {
    const partnerId = rom.u8(address + SUPPORT_OFFSET.partners + i);
    if (partnerId === 0) continue;

    actualCount++;
    partners.push({
      unitId: partnerId,
      unitName: unitNameOrId(nameMap, partnerId),
      initial: rom.u8(address + SUPPORT_OFFSET.initialValues + i),
      growth: rom.u8(address + SUPPORT_OFFSET.growthValues + i),
    });
  }

  const declaredCount = rom.u8(address + SUPPORT_OFFSET.declaredCount);

  return {
    unitId: 0, // filled in by the caller, which knows the unit
    unitName: '',
    address,
    declaredCount,
    actualCount,
    countMatches: declaredCount === actualCount,
    partners,
  };
}

/**
 * Read the support record for every unit that has one.
 *
 * `units` should come from {@link readAllUnits}; the name map is used to label
 * partners.
 */
export function readSupports(
  rom: RomBuffer,
  units: readonly Unit[],
  nameMap: ReadonlyMap<number, string>,
): SupportReadResult {
  const entries: SupportEntry[] = [];
  const missing: SupportReadResult['missing'] = [];

  for (const unit of units) {
    if (unit.isEmpty) continue;

    if (!unit.hasSupportData) {
      if (unit.supportPointer !== 0) {
        missing.push({
          unitId: unit.id,
          unitName: unit.name,
          rawPointer: unit.supportPointer,
        });
      }
      continue;
    }

    const record = readRecord(rom, unit.supportAddress, nameMap);
    if (record === null) {
      missing.push({
        unitId: unit.id,
        unitName: unit.name,
        rawPointer: unit.supportPointer,
      });
      continue;
    }

    record.unitId = unit.id;
    record.unitName = unit.name.length > 0 ? unit.name : unitNameOrId(nameMap, unit.id);
    entries.push(record);
  }

  return { entries, missing };
}

/**
 * Collapse the bidirectional records into one edge per pair.
 *
 * Ordering is normalised so `a < b`, which makes the result directly usable as
 * a graph and makes duplicate detection trivial.
 */
export function buildSupportGraph(
  entries: readonly SupportEntry[],
  nameMap: ReadonlyMap<number, string>,
): SupportGraphEdge[] {
  const byUnit = new Map<number, SupportEntry>();
  for (const entry of entries) byUnit.set(entry.unitId, entry);

  const edges: SupportGraphEdge[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    for (const partner of entry.partners) {
      // Normalise so an unordered pair always produces the same key.
      const a = Math.min(entry.unitId, partner.unitId);
      const b = Math.max(entry.unitId, partner.unitId);

      const key = `${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Always take the numbers from the a -> b record so the result does not
      // depend on which unit we happened to visit first.
      const aSide = byUnit.get(a)?.partners.find((p) => p.unitId === b);
      const source = aSide ?? partner;
      const reverse = byUnit.get(b)?.partners.find((p) => p.unitId === a);

      const edge: SupportGraphEdge = {
        a,
        b,
        aName: unitNameOrId(nameMap, a),
        bName: unitNameOrId(nameMap, b),
        initial: source.initial,
        growth: source.growth,
        reciprocal: reverse !== undefined,
      };

      if (
        reverse &&
        (reverse.initial !== source.initial || reverse.growth !== source.growth)
      ) {
        edge.mismatch = { initial: reverse.initial, growth: reverse.growth };
      }

      edges.push(edge);
    }
  }

  return edges;
}

export interface SupportValidation {
  /** Units whose declared partner count disagrees with the actual data. */
  countMismatches: { unitId: number; unitName: string; declared: number; actual: number }[];
  /** Pairs where A->B and B->A disagree. */
  valueMismatches: SupportGraphEdge[];
  /** A->B exists without B->A. */
  oneWayEdges: SupportGraphEdge[];
  /** Units with a non-zero support pointer that could not be followed. */
  unreadablePointers: SupportReadResult['missing'];
  /** Units listing more than seven partners (impossible in the data model). */
  overLimit: { unitId: number; unitName: string; declared: number }[];
  ok: boolean;
}

/** Self-consistency checks that need no external reference tool. */
export function validateSupports(
  result: SupportReadResult,
  nameMap: ReadonlyMap<number, string>,
): SupportValidation {
  const countMismatches = result.entries
    .filter((e) => !e.countMatches)
    .map((e) => ({
      unitId: e.unitId,
      unitName: e.unitName,
      declared: e.declaredCount,
      actual: e.actualCount,
    }));

  const graph = buildSupportGraph(result.entries, nameMap);

  const valueMismatches = graph.filter((e) => e.mismatch !== undefined);
  const oneWayEdges = graph.filter((e) => !e.reciprocal);
  const overLimit = result.entries
    .filter((e) => e.declaredCount > SUPPORT_LIMIT)
    .map((e) => ({
      unitId: e.unitId,
      unitName: e.unitName,
      declared: e.declaredCount,
    }));

  return {
    countMismatches,
    valueMismatches,
    oneWayEdges,
    unreadablePointers: result.missing,
    overLimit,
    ok:
      countMismatches.length === 0 &&
      valueMismatches.length === 0 &&
      oneWayEdges.length === 0 &&
      result.missing.length === 0 &&
      overLimit.length === 0,
  };
}
