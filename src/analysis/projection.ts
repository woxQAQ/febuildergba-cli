/**
 * Roster facts: starting stats and the fully-trained stat ceiling.
 *
 * This module answers "who is worth training" with **facts only**. An earlier
 * version also projected expected stats chapter by chapter, and summarised each
 * unit's join-time exp efficiency. Both were removed, because both were
 * arithmetic over assumptions and both were emitted in the same shape as read
 * facts:
 *   - a per-chapter level count taken from the exp curve's *parity* budget,
 *     times the unit's share of it, where the share divided by `deploy_slots`
 *     (a column this ROM leaves empty) and fell back to a constant;
 *   - a `ratio` of two such exp figures, which reads as "this unit gains a
 *     tenth of the exp" but is a quotient of numbers that each rest on the
 *     assumptions above.
 * A consumer - human or model - has no way to tell those apart from `hp: 26`,
 * so they should not be in the payload. `analysis/expcurve.ts` is the one place
 * assumptions are stated as such, in a `meta.assumptions` block; that is the
 * shape to follow rather than emitting assumed values bare.
 *
 * What remains is deterministic:
 *   - Starting stats are `class base + unit delta` (`model/stats.ts`,
 *     `startingStats`). Both terms are read from the ROM and the sum is exact.
 *     The unit table's `level` is the join level, reported as read.
 *   - {@link UnitProjection.maxed} is the ceiling: the current level grown to
 *     20 in the base class, the class's six `promotionBonuses` landing
 *     (`tables/classes.ts` `+34..39` - the ROM has no luck bonus), the level
 *     reset to 1, and the growth running to 20 again. Growth rates are unsigned
 *     percentages stored **per unit** (`tables/units.ts` `+28..34`); FE growths
 *     belong to the person rather than the class, so one set of rates runs
 *     through the whole trajectory, promotion included. This is "every growth
 *     succeeded, exactly" - not a probability, and not a plan.
 *   - Caps (`tables/classes.ts` `+19..25`) bind stepwise: once a stat reaches
 *     its current class's cap it stays there until a promotion raises the
 *     ceiling. That mirrors the in-game rule that a capped stat stops growing,
 *     which a single final `min()` would not.
 *   - `con` never grows and is excluded everywhere (contract `StatLine`).
 *   - The promotion direction is recovered from the reverse `promotesToClassId`
 *     link plus `sortOrder`, by `buildPromotionGraph` in `model/promotion.ts` -
 *     the one implementation, shared with extraction.
 *
 * Join chapter - same semantics as the `joins` command: a unit joins at the
 * earliest play-order position where it appears as a **player-side** placement
 * record or in a **player-side** unit block of a recruit-classified load
 * (`LOAD1`), collected by `analysis/appearances.ts`. Maps off every known story
 * path have no position to rank by, so a unit seen only there reads as
 * `joinPosition: null`, the same as a unit that never joins at all.
 *
 * A unit's stats at any chapter *other* than the one it joins in depend on how
 * much it was trained, which no table states - so this module does not claim to
 * know them. `startingStats` and `maxed` bracket the range instead: the floor
 * it enters with, and the ceiling it reaches if nothing is left un-grown.
 *
 * The roster is `hasSupportData && !isEmpty`: support data is the extractor's
 * existing marker for "a real player character" (enemies and NPCs have no
 * support pointer), and reusing it keeps this module consistent with the
 * support views instead of inventing a second playable predicate.
 */

import type { AnalysisUnit, ProjectionInput } from "./data.ts";
import type { ClassRecord } from "../model/records.ts";
import { buildPromotionGraph } from "../model/promotion.ts";
import { collectAppearances, isPlayerArmyAppearance } from "./appearances.ts";

export interface StatLine {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
}

/** One roster unit's read facts and its ceiling. */
export interface UnitProjection {
  unitId: number;
  name: string;
  /**
   * 1-based play-order position of the join chapter; `null` when the unit joins
   * on no known path.
   */
  joinPosition: number | null;
  /** 基础职业 → 上位职业。多条分支时全部列出,同名同类只出现一次。 */
  classLine: readonly { classId: number; name: string }[];
  /** 单位表 level 字段:入队等级,原样读出。 */
  level: number;
  /** 入队即上级职业。 */
  promotedAtJoin: boolean;
  /** `class base + unit delta`,精确值。 */
  startingStats: StatLine;
  /**
   * 满练上限:全部成长成功、转职加成到手、按当时职业 cap 截断后的属性。
   * 与训练计划无关 - 它是天花板,不是任何一次游玩的结果。
   *
   * 有多条转职分支时取 **class id 最小的那条**(与 {@link classLine} 的首个上位职业一致),
   * 因为一个单位只能走一条分支。每条分支各自的上限见 {@link maxedByBranch}:
   * 按属性逐项取最大值会拼出一个不存在的单位。
   */
  maxed: StatLine;
  /**
   * 每条转职分支各自的天花板。无声明的单一分支单位只有一项,与 {@link maxed} 相同。
   */
  maxedByBranch: readonly { classId: number; name: string; stats: StatLine }[];
}

type GrownStat = keyof StatLine;

const GROWN_STATS: readonly GrownStat[] = ["hp", "str", "skl", "spd", "def", "res", "lck"];

/** Level cap every GBA FE class shares; the class table carries no per-class value. */
const MAX_LEVEL = 20;

// ------------------------------------------------------------------- joins

/**
 * unit id -> earliest play-order position at which it joins the player's army.
 * Off every known story path there is no chapter slot to rank the unit by, so
 * the unit is absent here and reads as `null` downstream.
 */
function buildJoinPositions(data: ProjectionInput): Map<number, number> {
  const best = new Map<number, number>();
  for (const a of collectAppearances(data)) {
    if (!isPlayerArmyAppearance(a)) continue;
    const position = data.playOrder.position.get(a.mapIndex);
    if (position === undefined) continue;
    const current = best.get(a.unitId);
    if (current === undefined || position < current) best.set(a.unitId, position);
  }
  return best;
}

// ----------------------------------------------------------------- ceiling

interface CeilingContext {
  growths: Readonly<Record<GrownStat, number>>;
  classById: ReadonlyMap<number, ClassRecord>;
  targets: ReadonlyMap<number, readonly ClassRecord[]>;
}

function growBy(stats: Record<GrownStat, number>, levels: number, ctx: CeilingContext): void {
  for (const s of GROWN_STATS) stats[s] += (ctx.growths[s] * levels) / 100;
}

/** Caps bind permanently until a promotion raises them, so truncation is stepwise. */
function capAt(stats: Record<GrownStat, number>, cls: ClassRecord | undefined): void {
  if (cls === undefined) return; // class id outside the table: no caps to apply
  for (const s of GROWN_STATS) {
    // The cap row's seventh field is con, not luck (same order as `bases`):
    // luck has no class cap, exactly like it has no promotion bonus.
    if (s === "lck") continue;
    stats[s] = Math.min(stats[s], cls.caps[s]);
  }
}

/** Display rounding only: 1 decimal. */
function toStatLine(stats: Readonly<Record<GrownStat, number>>): StatLine {
  const out = {} as Record<GrownStat, number>;
  for (const s of GROWN_STATS) out[s] = Math.round(stats[s] * 10) / 10;
  return out;
}

/**
 * Growth span still available in the class the unit is in: the levels from
 * `level` to 20. A unit at or past 20 clamps to 0 rather than skipping the leg -
 * it still gets the promotion and the promoted-class growth below (that is the
 * in-game rule too).
 */
function spansToCap(level: number): number {
  return Math.max(0, MAX_LEVEL - level);
}

/**
 * The ceiling along one promotion target. Called once per branch so a caller
 * can see what each branch actually reaches; the reported `maxed` is the first
 * of them, because a unit walks one branch, not the per-stat maximum of several.
 */
function ceilingThrough(
  statsIn: Readonly<Record<GrownStat, number>>,
  target: ClassRecord,
  ctx: CeilingContext,
): Record<GrownStat, number> {
  const branch = { ...statsIn } as Record<GrownStat, number>;
  // Six bonuses - the ROM has no promotion luck bonus (`tables/classes.ts`),
  // and the level resets to 1, so the promoted leg is 19 levels.
  for (const s of GROWN_STATS) {
    if (s === "lck") continue;
    branch[s] += target.promotionBonuses[s];
  }
  capAt(branch, target);
  growBy(branch, spansToCap(1), ctx);
  capAt(branch, target);
  return branch;
}

/**
 * The fully-trained ceiling. A unit that joined promoted has no base-class leg:
 * its base is behind it and we never learn the level it left at, so the growth
 * runs once, in the class it is in.
 *
 * A class with several promotion branches (the CC menu offers two, and `+5` may
 * name a third) has one ceiling per branch. Each is computed and reported
 * separately by {@link maxedByBranch}; `maxed` is the first, which is stable
 * because the branch list is sorted by class id.
 */
function maxedStats(
  unit: AnalysisUnit,
  ctx: CeilingContext,
): { maxed: StatLine; byBranch: readonly { classId: number; name: string; stats: StatLine }[] } {
  const cls = ctx.classById.get(unit.classId);
  const stats = {} as Record<GrownStat, number>;
  for (const s of GROWN_STATS) stats[s] = unit.startingStats[s];
  capAt(stats, cls);

  growBy(stats, spansToCap(unit.level), ctx);
  capAt(stats, cls);

  // A class with no outgoing promotion edge is the end of its line, whatever the
  // unit table's promoted flag says. Anything else continues below.
  const branches = ctx.targets.get(unit.classId) ?? [];
  if (branches.length === 0) {
    // No promotion left: a unit whose flag says promoted has its base behind it.
    return { maxed: toStatLine(stats), byBranch: [] };
  }

  const byBranch = branches.map((target) => ({
    classId: target.id,
    name: target.name,
    stats: toStatLine(ceilingThrough(stats, target, ctx)),
  }));

  return { maxed: (byBranch[0] as { stats: StatLine }).stats, byBranch };
}

// -------------------------------------------------------------------- public

/**
 * Every roster unit's read facts and ceiling, ordered by join position (earliest
 * first, never-joining last, unit id as tie-break) - the order a "who do I
 * train" reader scans in.
 */
export function projectUnits(data: ProjectionInput): UnitProjection[] {
  const classById = new Map(data.classes.map((c) => [c.id, c]));
  const graph = buildPromotionGraph(data.classes, data.classBranches);
  const joins = buildJoinPositions(data);

  const projections: UnitProjection[] = [];
  for (const unit of data.units) {
    if (unit.isEmpty || !unit.hasSupportData) continue;

    const cls = classById.get(unit.classId);

    // "Still has a promotion left" is an outgoing-edge question, not the unit
    // table's `is_promoted_class`: a hack can reach a class that is both a
    // promotion target and a promotion source (Vision Quest's three-tier chains
    // reach Mage 37 / Shaman 45 / Pirate 66 from a trainee class, and each of
    // them promotes again). Reading the flag there reported six roster units as
    // "joined promoted", which suppresses their branch line and their ceiling.
    const branches = graph.targetsAll.get(unit.classId);
    const hasPromotion = branches !== undefined && branches.length > 0;

    // The class line as "base -> promoted". A unit that has no promotion left
    // has its base behind it: the reverse link points back at it.
    const classLine: { classId: number; name: string }[] = [];
    if (!hasPromotion && unit.isPromotedClass && cls !== undefined) {
      const base = classById.get(cls.promotesToClassId);
      if (base !== undefined && base.sortOrder < cls.sortOrder) {
        classLine.push({ classId: base.id, name: base.name });
      }
    }
    classLine.push({ classId: unit.classId, name: unit.className });
    // Every branch the class can take, not one arbitrary pick: a class reached
    // through `targets` alone used to show a single (sometimes wrong) target.
    // Deduplicated by display name: the class table carries duplicate profiles
    // (two `Sentinel` ids) and repeating one in a "base -> promoted" line reads
    // as a second promotion step that does not exist.
    const seenNames = new Set(classLine.map((c) => c.name));
    for (const target of branches ?? []) {
      if (seenNames.has(target.name)) continue;
      seenNames.add(target.name);
      classLine.push({ classId: target.id, name: target.name });
    }

    const startingStats = {} as StatLine;
    for (const s of GROWN_STATS) startingStats[s] = unit.startingStats[s];

    const ceiling = maxedStats(unit, {
      growths: unit.growths,
      classById,
      targets: graph.targetsAll,
    });

    projections.push({
      unitId: unit.id,
      name: unit.name,
      joinPosition: joins.get(unit.id) ?? null,
      classLine,
      level: unit.level,
      promotedAtJoin: !hasPromotion && unit.isPromotedClass,
      startingStats,
      maxed: ceiling.maxed,
      maxedByBranch: ceiling.byBranch,
    });
  }

  projections.sort(
    (a, b) => (a.joinPosition ?? Infinity) - (b.joinPosition ?? Infinity) || a.unitId - b.unitId,
  );
  return projections;
}
