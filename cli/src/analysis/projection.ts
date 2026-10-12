/**
 * Expected-stat projection: "if we field unit U up to chapter N, what stats
 * does it have" - the growth half of "who is worth training".
 *
 * This is **expectation arithmetic, not a probability simulation**: a stat's
 * expected value after `k` level-ups is `base + growth * k / 100`, and the
 * trajectory below is that expectation carried chapter by chapter. The
 * contrast with `extract/unitStats.ts` is deliberate and worth stating:
 *   - `unitStats.ts` ports FEBuilderGBA's `GrowSimulator` line by line to
 *     reproduce what the *game* shows for one fixed appearance - bit-exact
 *     doubles, C# banker's rounding (`csRound`), upstream's `> 256` clamp
 *     quirk, and deliberately **no** class caps.
 *   - Here we answer a planning question, so plain floating point is the
 *     right tool: no rounding until display (1 decimal), and class stat caps
 *     **are** applied, because "how close to the cap does this unit get" is
 *     exactly what a training recommendation needs.
 *
 * Rules and where they come from:
 *   - Starting stats are `class base + unit delta` (`model/stats.ts`,
 *     `startingStats`); the unit table's `level` field is the join level.
 *   - Growth rates are unsigned percentages stored **per unit**
 *     (`tables/units.ts` `+28..34`). FE growths belong to the person, not the
 *     class, so one set of rates runs through the whole trajectory,
 *     promotion included.
 *   - Promotion adds the class table's six `promotionBonuses`
 *     (`tables/classes.ts` `+34..39` - the ROM has no luck bonus) and resets
 *     the level to 1. The promotion *direction* is recovered from the reverse
 *     `promotesToClassId` link plus `sortOrder`, by `buildPromotionGraph` in
 *     `model/promotion.ts` - the one implementation, shared with extraction.
 *   - Caps (`tables/classes.ts` `+19..25`) bind stepwise: once a stat
 *     reaches its current class's cap it stays there until a promotion
 *     raises the ceiling. That mirrors the in-game rule that a capped stat
 *     stops growing, which a single final `min()` would not.
 *   - `con` never grows and is excluded everywhere (contract `StatLine`).
 *
 * Join chapter - same semantics as the `joins` command: a unit joins at the
 * earliest play-order position where it appears as a **player-side**
 * placement record or in a **player-side** unit block of a recruit-classified
 * load (`LOAD1`), collected by `analysis/appearances.ts`. Maps off every
 * known story path have no position to project from, so a unit seen only
 * there reads as `joinPosition: null`, the same as a unit that never joins
 * at all.
 *
 * Modelling choices a reader should not have to reverse-engineer:
 *   - `levelsPerChapter` is a continuous expectation, so levels are
 *     fractional-capable. Promotion fires at the first crossing of
 *     `promoteAt`: growth up to the threshold accrues under the old class's
 *     caps, the bonus lands, the level resets to 1, and any overshoot
 *     accrues post-promotion. Since the rates are personal, the split point
 *     changes *which caps and bonus apply*, never the total growth.
 *   - Levels never exceed {@link MAX_LEVEL} (20) per class: once capped, a
 *     unit with no promotion left gains nothing further. The old flat
 *     default never made this visible; the parity budget overfeeds a single
 *     unit fast enough that the cap is what keeps the trajectory sane.
 *   - The default per-chapter level gain is not a fixed constant: it is the
 *     chapter's `expectedLevelsAtParity` from `analysis/expcurve.ts` times
 *     the unit's share of it. The budget is a roster-level resource - the
 *     exp one fighter would earn solo-clearing the chapter - so a unit
 *     deployed alongside a full squad gets `1/deploySlots` of it by
 *     default. Harder chapters offer more exp by fielding more and
 *     boss/thief-flagged enemies. An explicit `levelsPerChapter` overrides
 *     with a flat rate; `expShare` overrides the share only.
 *   - A unit's share is further scaled by its join-time exp efficiency
 *     (`ExpEfficiency.ratio`): a promoted or high-power unit converts the
 *     same chapter budget into fewer levels. The ratio is frozen at the
 *     join profile; the full feedback loop (recomputing exp from the
 *     projected level each chapter) is a follow-up, as is the parity
 *     assumption itself (a unit ahead of the curve earns less per kill
 *     in-game than credited here).


 *   - `levelTrack` renders the trajectory in the community's `base/promoted`
 *     notation: `"15"` while unpromoted, `"20/3"` after promoting at base
 *     level 20 and gaining 2 further levels (reset to 1, then +2). A unit
 *     that joined already promoted shows just its level - we never learn
 *     when it promoted.
 *   - `maxed` is the option-independent ceiling: Lv20 in the base class,
 *     promote, Lv20 in the promoted class (no promotion: Lv20 in the current
 *     class). It ignores `promoteAt` on purpose - it answers "fully trained"
 *     rather than "trained under this plan".
 *   - The roster is `hasSupportData && !isEmpty`: support data is the
 *     extractor's existing marker for "a real player character" (enemies and
 *     NPCs have no support pointer), and reusing it keeps this module
 *     consistent with the support views instead of inventing a second
 *     playable predicate.
 */

import type { AnalysisClass, AnalysisUnit, ExpCurveInput, ProjectionInput } from "./data.ts";
import type { Difficulty } from "../model/stats.ts";
import { buildPromotionGraph } from "../model/promotion.ts";
import { collectAppearances, isPlayerArmyAppearance } from "./appearances.ts";
import type { CombatantProfile } from "./expcurve.ts";
import { battleExp, combatantOf, computeExpCurve } from "./expcurve.ts";

export interface StatLine {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
}

export interface ProjectionPoint {
  /** derived_play_order 的 1-based position。 */
  position: number;
  /** 该点的期望等级轨迹,如 "12/3"(转职后 3 级)或 "15"(未转职)。 */
  levelTrack: string;
  promoted: boolean;
  /** 期望值,保留 1 位小数,已按当时职业 cap 截断。 */
  stats: StatLine;
}

/**
 * 入队时的「经验效率」概要:该单位击杀一个同级参照敌所得经验,相对于一个
 * 标准基础职业单位(power = 参照敌 power、未转职)的比值。语义:
 *   - classPower 越高,伤害经验项 ÷power 越小,即「高 power 职业吃经验少」;
 *   - 入队即上级的单位有效等级 +20、bonus B 抬升自身 powerLevel,两项一起
 *     压缩经验 — 这就是上级单位挤压下级成长的量化。
 * ratio < 1 表示低于标准线(典型:入队即转职的单位);> 1 见于学徒系
 * (power 1-2)。
 */
export interface ExpEfficiency {
  /** 入队职业的 class power(职业表 +26)。 */
  classPower: number;
  /** 参照敌的 power:入队章敌方众数;无章或无敌时退回 3(全版本标准值)。 */
  enemyPowerRef: number;
  /** 入队时是否已是上级职业。 */
  promotedAtJoin: boolean;
  /** 击杀同级参照敌的经验(无 boss/thief 加成,假设命中且击杀)。 */
  expPerParityKill: number;
  /** 同条件下标准基础职业单位的对照经验。 */
  baselineExpPerParityKill: number;
  /** expPerParityKill / baseline,保留 2 位小数。 */
  ratio: number;
}

export interface UnitProjection {
  unitId: number;
  name: string;
  joinPosition: number | null;
  /** 基础职业 → 上位职业。 */
  classLine: readonly { classId: number; name: string }[];
  points: readonly ProjectionPoint[];
  /**
   * 入队时的经验效率概要;单位从不入队(或入队章不在任何已知路径上)时为
   * null — 没有可参照的入队章敌方 power。
   */
  expEfficiency: ExpEfficiency | null;
  /**
   * 满练投影:Lv20 基础职业 → 转职 → Lv20 上位(无转职则 Lv20/当前职业上限),
   * cap 截断。与 options 无关 - 它是天花板,不是某个训练计划的结果。
   */
  maxed: StatLine;
}

export interface ProjectionOptions {
  /**
   * 每章期望升级数的显式覆盖(平坦值)。缺省时消费 expcurve:取该章
   * `expectedLevelsAtParity` 乘以经验份额(见 `expShare`)。
   */
  levelsPerChapter?: number;
  /** 转职时机:基础职业达到该等级即转,默认 20。 */
  promoteAt?: number;
  /** expcurve 预算与经验效率参照的难度,默认 "normal"。 */
  difficulty?: Difficulty;
  /**
   * 该单位在每章经验预算中的份额,0-1。缺省为 1/deploySlots(满编出战
   * 平分);该章无 deploy 数据时退回 {@link DEFAULT_EXP_SHARE}。
   */
  expShare?: number;
}

type GrownStat = keyof StatLine;

const GROWN_STATS: readonly GrownStat[] = ["hp", "str", "skl", "spd", "def", "res", "lck"];

/** Level cap every GBA FE class shares; the class table carries no per-class value. */
const MAX_LEVEL = 20;

/** Tolerance for fractional-level comparisons; binary floats make `0.1` sums drift. */
const EPSILON = 1e-9;

// ------------------------------------------------------------- exp efficiency

/** Vanilla standard enemy class power; the fallback when a join chapter has no
 *  counted enemies (or the unit never joins on a known path). */
const STANDARD_ENEMY_POWER = 3;

/**
 * A unit's default share of a chapter's exp budget when the map carries no
 * deploy-slot count: a full GBA squad deploys ~10.
 */
const DEFAULT_EXP_SHARE = 0.1;

/**
 * The join-time exp efficiency summary: this unit's exp for killing one
 * same-level reference enemy vs a standard base-class unit's. See
 * {@link ExpEfficiency} for the semantics.
 */
function expEfficiencyOf(
  unit: AnalysisUnit,
  cls: AnalysisClass | undefined,
  enemyPowerRef: number,
  classById: ReadonlyMap<number, AnalysisClass>,
  game: ExpCurveInput["game"],
  difficulty: Difficulty,
): ExpEfficiency | null {
  if (cls === undefined) return null; // class id outside the table: no power
  const actor = combatantOf(cls, unit.level, unit.isPromotedClass, classById, game);
  const reference: CombatantProfile = {
    level: unit.level,
    classPower: enemyPowerRef,
    promoted: false,
    linkedClassPower: 0,
    boss: false,
    thief: false,
    mummy: false,
    noExp: false,
  };
  const ours = battleExp(actor, reference, game, difficulty);
  const baseline = battleExp(reference, reference, game, difficulty);
  return {
    classPower: cls.classPower,
    enemyPowerRef,
    promotedAtJoin: unit.isPromotedClass,
    expPerParityKill: ours,
    baselineExpPerParityKill: baseline,
    // `baseline` is `battleExp` clamped to [EXP_MIN, EXP_MAX] = [1, 100], so
    // the division always has a non-zero divisor.
    ratio: Math.round((ours / baseline) * 100) / 100,
  };
}

// --------------------------------------------------------------- join chapters

/**
 * unit id -> earliest play-order position at which it joins the player's
 * army. See the module doc for the semantics; appearances come from the
 * shared collector in `analysis/appearances.ts`.
 */
function buildJoinPositions(data: ProjectionInput): Map<number, number> {
  const best = new Map<number, number>();
  for (const a of collectAppearances(data)) {
    if (!isPlayerArmyAppearance(a)) continue;
    // Off every known story path: there is no chapter slot to project from.
    const position = data.playOrder.position.get(a.mapIndex);
    if (position === undefined) continue;
    const current = best.get(a.unitId);
    if (current === undefined || position < current) best.set(a.unitId, position);
  }
  return best;
}

// ----------------------------------------------------------------- simulation

interface SimContext {
  growths: Readonly<Record<GrownStat, number>>;
  classById: ReadonlyMap<number, AnalysisClass>;
  targets: ReadonlyMap<number, AnalysisClass>;
  promoteAt: number;
}

interface SimState {
  /** Full-precision expectation, cap-truncated at every step. */
  stats: Record<GrownStat, number>;
  /** Level within the current class; resets to 1 on promotion. Fractional-capable. */
  level: number;
  promoted: boolean;
  /** Base-class level at which our simulation promoted, or null when the unit joined promoted. */
  promoteLevel: number | null;
  classId: number;
}

function growBy(state: SimState, levels: number, ctx: SimContext): void {
  for (const s of GROWN_STATS) state.stats[s] += (ctx.growths[s] * levels) / 100;
}

/** Caps bind permanently until a promotion raises them, so truncation is stepwise. */
function capAt(state: SimState, cls: AnalysisClass | undefined): void {
  if (cls === undefined) return; // class id outside the table: no caps to apply
  for (const s of GROWN_STATS) {
    // The cap row's seventh field is con, not luck (same order as `bases`):
    // luck has no class cap, exactly like it has no promotion bonus.
    if (s === "lck") continue;
    state.stats[s] = Math.min(state.stats[s], cls.caps[s]);
  }
}

function applyPromotion(state: SimState, target: AnalysisClass): void {
  // Six bonuses - the ROM has no promotion luck bonus (`tables/classes.ts`).
  for (const s of GROWN_STATS) {
    if (s === "lck") continue;
    state.stats[s] += target.promotionBonuses[s];
  }
  state.promoteLevel = state.level;
  state.level = 1;
  state.promoted = true;
  state.classId = target.id;
  capAt(state, target);
}

function initState(unit: AnalysisUnit, cls: AnalysisClass | undefined): SimState {
  const stats = {} as Record<GrownStat, number>;
  for (const s of GROWN_STATS) stats[s] = unit.startingStats[s];
  const state: SimState = {
    stats,
    level: unit.level,
    promoted: unit.isPromotedClass,
    promoteLevel: null,
    classId: unit.classId,
  };
  capAt(state, cls);
  return state;
}

/**
 * Advance the expectation by `levels` level-ups, promoting at the first
 * crossing of `promoteAt` when the class has a promotion and the unit did not
 * join promoted. The step is split at the threshold: growth before it accrues
 * under the old class's caps, the bonus lands, and the overshoot accrues
 * under the new ones. Levels stop at {@link MAX_LEVEL} per class - a capped
 * unit earns exp but no levels, so the remainder is discarded, not carried.
 */
function advance(state: SimState, levels: number, ctx: SimContext): void {
  let remaining = levels;
  while (remaining > EPSILON) {
    const target = state.promoted ? undefined : ctx.targets.get(state.classId);
    if (target !== undefined && state.level + remaining >= ctx.promoteAt - EPSILON) {
      const pre = ctx.promoteAt - state.level;
      growBy(state, pre, ctx);
      state.level = ctx.promoteAt;
      capAt(state, ctx.classById.get(state.classId));
      applyPromotion(state, target);
      remaining -= pre;
    } else {
      const room = Math.max(0, MAX_LEVEL - state.level);
      const step = Math.min(remaining, room);
      growBy(state, step, ctx);
      state.level += step;
      capAt(state, ctx.classById.get(state.classId));
      remaining -= step;
      if (room <= EPSILON) break; // capped at 20 with no promotion left
    }
  }
}

/** Levels are integers in the common case; keep the display clean when they are. */
function formatLevel(level: number): string {
  const rounded = Math.round(level * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Display rounding only: 1 decimal, applied to the carried expectation. */
function toStatLine(stats: Readonly<Record<GrownStat, number>>): StatLine {
  const out = {} as Record<GrownStat, number>;
  for (const s of GROWN_STATS) out[s] = Math.round(stats[s] * 10) / 10;
  return out;
}

function snapshot(state: SimState, position: number): ProjectionPoint {
  return {
    position,
    levelTrack:
      state.promoted && state.promoteLevel !== null
        ? `${formatLevel(state.promoteLevel)}/${formatLevel(state.level)}`
        : formatLevel(state.level),
    promoted: state.promoted,
    stats: toStatLine(state.stats),
  };
}

/**
 * The fully-trained ceiling, independent of `ProjectionOptions`: Lv20 in the
 * base class, promote, Lv20 in the promoted class. A unit at or past 20 in a
 * promotable class still gets its promotion (that is the in-game rule too),
 * so the pre-promotion growth span clamps at 0 rather than skipping it.
 */
function maxedStats(unit: AnalysisUnit, ctx: SimContext): StatLine {
  const cls = ctx.classById.get(unit.classId);
  const state = initState(unit, cls);
  const target = unit.isPromotedClass ? undefined : ctx.targets.get(unit.classId);
  growBy(state, Math.max(0, MAX_LEVEL - state.level), ctx);
  capAt(state, cls);
  if (target !== undefined) {
    applyPromotion(state, target);
    growBy(state, MAX_LEVEL - 1, ctx);
    capAt(state, target);
  }
  return toStatLine(state.stats);
}

// -------------------------------------------------------------------- public

/**
 * Project every roster unit's expected stats over the play order.
 *
 * Units are returned by join position (earliest first, never-joining last,
 * unit id as tie-break) - the order a "who do I train" reader scans in.
 */
export function projectUnits(
  data: ProjectionInput,
  opts: ProjectionOptions = {},
): UnitProjection[] {
  const promoteAt = opts.promoteAt ?? MAX_LEVEL;
  const difficulty = opts.difficulty ?? "normal";
  const curve = computeExpCurve(data);

  // Levels per chapter: an explicit flat override when given; else the
  // chapter's parity budget times the unit's share of it. The budget is a
  // roster-level resource (one fighter solo-clearing the chapter), so a unit
  // deployed alongside a full squad gets 1/deploySlots by default. Chapters
  // with no counted enemies grant nothing - there is no one to fight.
  const deploySlotsByMap = new Map(data.chapters.map((c) => [c.index, c.deploySlots]));
  const shareOf = (mapIndex: number): number => {
    if (opts.expShare !== undefined) return opts.expShare;
    const slots = deploySlotsByMap.get(mapIndex);
    return slots !== undefined && slots > 0 ? 1 / slots : DEFAULT_EXP_SHARE;
  };
  const levelsOf = ((): ((position: number, mapIndex: number) => number) => {
    if (opts.levelsPerChapter !== undefined) return () => opts.levelsPerChapter as number;
    const byPosition = new Map<number, number>();
    for (const b of curve.budgets) {
      if (b.difficulty === difficulty) byPosition.set(b.position, b.expectedLevelsAtParity);
    }
    // `computeExpCurve` budgets every playable step at every difficulty, so a
    // position drawn from the playable steps (the only caller below) always hits.
    return (position, mapIndex) => (byPosition.get(position) as number) * shareOf(mapIndex);
  })();
  const powerRefOf = ((): ((position: number) => number) => {
    const byPosition = new Map<number, number>();
    for (const b of curve.budgets) {
      if (b.difficulty === difficulty && b.typicalClassPower !== null) {
        byPosition.set(b.position, b.typicalClassPower);
      }
    }
    return (position) => byPosition.get(position) ?? STANDARD_ENEMY_POWER;
  })();

  const classById = new Map(data.classes.map((c) => [c.id, c]));
  const targets = buildPromotionGraph(data.classes).targets;
  const joins = buildJoinPositions(data);
  // Non-playable rows (a chain's terminal transition stop) pass no chapter,
  // so they grant no levels and emit no points.
  const playable = data.playOrder.steps.filter((s) => s.playable);

  const projections: UnitProjection[] = [];
  for (const unit of data.units) {
    if (unit.isEmpty || !unit.hasSupportData) continue;

    const ctx: SimContext = { growths: unit.growths, classById, targets, promoteAt };
    const cls = classById.get(unit.classId);
    const joinPosition = joins.get(unit.id) ?? null;

    // The class line as "base -> promoted". A unit that joined promoted has
    // its base behind it: the reverse link points back at it.
    const classLine: { classId: number; name: string }[] = [];
    if (unit.isPromotedClass && cls !== undefined) {
      const base = classById.get(cls.promotesToClassId);
      if (base !== undefined && base.sortOrder < cls.sortOrder) {
        classLine.push({ classId: base.id, name: base.name });
      }
    }
    classLine.push({ classId: unit.classId, name: unit.className });
    const target = unit.isPromotedClass ? undefined : targets.get(unit.classId);
    if (target !== undefined) classLine.push({ classId: target.id, name: target.name });

    const state = initState(unit, cls);
    // Already at or past the threshold on join: promote on the spot.
    if (!state.promoted && state.level >= promoteAt && target !== undefined) {
      applyPromotion(state, target);
    }

    const efficiency =
      joinPosition === null
        ? null
        : expEfficiencyOf(unit, cls, powerRefOf(joinPosition), classById, data.game, difficulty);

    const points: ProjectionPoint[] = [];
    if (joinPosition !== null) {
      // The join chapter itself is the baseline point: starting stats, no growth.
      points.push(snapshot(state, joinPosition));
      // The same chapter budget converts into fewer levels for a promoted or
      // high-power unit; the ratio is frozen at the join profile (module doc).
      const rate = efficiency?.ratio ?? 1;
      for (const step of playable) {
        if (step.order <= joinPosition) continue;
        advance(state, levelsOf(step.order, step.mapIndex) * rate, ctx);
        points.push(snapshot(state, step.order));
      }
    }

    projections.push({
      unitId: unit.id,
      name: unit.name,
      joinPosition,
      classLine,
      points,
      expEfficiency: efficiency,
      maxed: maxedStats(unit, ctx),
    });
  }

  projections.sort(
    (a, b) => (a.joinPosition ?? Infinity) - (b.joinPosition ?? Infinity) || a.unitId - b.unitId,
  );
  return projections;
}
