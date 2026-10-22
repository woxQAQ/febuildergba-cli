/**
 * Starting stats and full-training projections for roster units and joiners.
 *
 * Starting stats sum class bases and unit deltas; they are not saved-game
 * stats. A projection adds personal growth rate * level span / 100, applies
 * caps at each phase, and includes at most one promotion with its six bonuses
 * and a level reset to 1. Luck has neither a class cap nor a promotion bonus
 * in this model; constitution is outside StatLine.
 *
 * These deterministic calculations are not all-growths-successful upper
 * bounds, exact expectations of capped random growth, or proof that enough
 * exp and promotion items exist. An actual run may end above or below them.
 * Each direct promotion target is kept separate; `maxed` chooses the smallest
 * target class id, never a per-stat combination of mutually exclusive branches.
 *
 * Army entries reuse `isPlayerArmyAppearance`. The pool is the union of
 * non-empty support-bearing units and recognized joiners, including off-route
 * joiners. `joinPosition: null` alone cannot distinguish an off-route entry
 * from no entry: consumers use availability's explicit join state.
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

/** One candidate's starting facts and branch-specific projections. */
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
  /** 单位表 level 字段，原样读出；未应用入队布阵或加载覆盖。 */
  level: number;
  /** 入队即上级职业。 */
  promotedAtJoin: boolean;
  /**
   * 入队后还有没有转职可走，即当前职业是否有出边。这是判断「还能不能转」的直接
   * 字段：`classLine` 的项数描述的是入队前走过的路，`promotedAtJoin` 只说明
   * 单位表标记了已晋升且无出边，两者都不能当这个问题的答案。
   */
  promotable: boolean;
  /** 单位表职业的 `class base + unit delta`，不代表已验证的实际入队属性。 */
  startingStats: StatLine;
  /**
   * 满练属性投影：成长率 × 等级跨度 / 100，加转职加成，按各阶段职业 cap 截断。
   * 不是全部成长成功的上限，也不是随机封顶过程的严格期望或实际训练结果。
   *
   * 有多条转职分支时取 **class id 最小的那条**(与 {@link classLine} 的首个上位职业一致),
   * 因为一个单位只能走一条分支。每条分支各自的投影见 {@link maxedByBranch}:
   * 按属性逐项取最大值会拼出一个不存在的单位。
   */
  maxed: StatLine;
  /**
   * 每条直接转职分支各自的投影，最多一次转职；没有出边时为空数组。
   */
  maxedByBranch: readonly { classId: number; name: string; stats: StatLine }[];
}

type GrownStat = keyof StatLine;

const GROWN_STATS: readonly GrownStat[] = ["hp", "str", "skl", "spd", "def", "res", "lck"];

/** Level cap every GBA FE class shares; the class table carries no per-class value. */
const MAX_LEVEL = 20;

// ------------------------------------------------------------------- joins

/**
 * unit id -> earliest play-order position at which it joins the player's army,
 * or `null` when it joins only on a map the play order does not cover. Absent
 * means the unit never joins at all.
 */
function buildJoinPositions(data: ProjectionInput): Map<number, number | null> {
  const best = new Map<number, number | null>();
  for (const a of collectAppearances(data)) {
    if (!isPlayerArmyAppearance(a)) continue;
    const position = data.playOrder.position.get(a.mapIndex);
    // A join on a map the play order does not cover still means the unit joins:
    // keep it with a `null` position so callers can tell "joins off-route" from
    // "never joins".
    if (position === undefined) {
      if (!best.has(a.unitId)) best.set(a.unitId, null);
      continue;
    }
    const current = best.get(a.unitId);
    if (current === null || current === undefined || position < current)
      best.set(a.unitId, position);
  }
  return best;
}

// -------------------------------------------------------------- projection

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

/** Level-span proxy for this projection, not exp, turns or training feasibility. */
export function trainingLevelsForProjection(level: number, promotes: boolean): number {
  return spansToCap(level) + (promotes ? spansToCap(1) : 0);
}

/**
 * The projection along one promotion target. Called once per branch so a caller
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
 * The full-training projection. A unit with no outgoing edge has no later leg:
 * its base is behind it and we never learn the level it left at, so the growth
 * runs once, in the class it is in.
 *
 * A class with several promotion branches (the CC menu offers two, and `+5` may
 * name a third) has one projection per branch. Each is computed and reported
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
 * Every unit worth projecting - the roster (`hasSupportData`) plus any unit that
 * joins the player's army - ordered by join position (earliest first,
 * never-joining last, unit id as tie-break), the order a "who do I train"
 * reader scans in.
 *
 * The two predicates are unioned rather than intersected because neither contains
 * the other on real hacks: a roster unit can never join (The Drowned King: 10 of
 * 62), and a joiner can sit outside the roster (dragonherald: 14 of 48).
 */
export function projectUnits(data: ProjectionInput): UnitProjection[] {
  const classById = new Map(data.classes.map((c) => [c.id, c]));
  const graph = buildPromotionGraph(data.classes, data.classBranches);
  const joinOf = buildJoinPositions(data);

  const projections: UnitProjection[] = [];
  for (const unit of data.units) {
    if (unit.isEmpty) continue;
    // The pool is "roster **or** joins somewhere", not the roster alone. A hack
    // can put a playable unit outside the support table (dragonherald: 14 of
    // its 48 joiners), and those units are exactly the ones a line-up has to
    // weigh - dropping them left the highest-growth unit in that ROM with no
    // projection row at all. Off-order joiners are included for the same
    // reason: they join, they just have no main-line position.
    const joinPosition = joinOf.get(unit.id);
    if (!unit.hasSupportData && joinPosition === undefined) continue;

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
      joinPosition: joinPosition ?? null,
      classLine,
      level: unit.level,
      promotedAtJoin: !hasPromotion && unit.isPromotedClass,
      promotable: hasPromotion,
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
