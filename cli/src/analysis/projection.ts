/**
 * Expected-stat projection: "if we field unit U up to chapter N, what stats
 * does it have" - the growth half of "who is worth training".
 *
 * This is **expectation arithmetic, not a probability simulation**: a stat's
 * expected value after `k` level-ups is `base + growth * k / 100`, and the
 * trajectory below is that expectation carried chapter by chapter. The
 * contrast with `tables/unitStats.ts` is deliberate and worth stating:
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
 *   - Starting stats are `class base + unit delta` (`tables/units.ts`,
 *     `startingStats`); the unit table's `level` field is the join level.
 *   - Growth rates are unsigned percentages stored **per unit**
 *     (`tables/units.ts` `+28..34`). FE growths belong to the person, not the
 *     class, so one set of rates runs through the whole trajectory,
 *     promotion included.
 *   - Promotion adds the class table's six `promotionBonuses`
 *     (`tables/classes.ts` `+34..39` - the ROM has no luck bonus) and resets
 *     the level to 1. The promotion *direction* is recovered from the
 *     reverse `promotesToClassId` link plus `sortOrder`, the same tie-break
 *     `promotedClassIdsOf` in `load.ts` uses (duplicated here, not imported:
 *     `load.ts` does not export it).
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

import type { ParsedRom } from "../load.ts";
import type { UnitClass } from "../tables/classes.ts";
import type { EventTrace } from "../tables/eventTrace.ts";
import { extractEventTrace } from "../tables/eventTrace.ts";
import { collectAppearances } from "./appearances.ts";
import type { Unit } from "../tables/units.ts";

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

export interface UnitProjection {
  unitId: number;
  name: string;
  joinPosition: number | null;
  /** 基础职业 → 上位职业。 */
  classLine: readonly { classId: number; name: string }[];
  points: readonly ProjectionPoint[];
  /**
   * 满练投影:Lv20 基础职业 → 转职 → Lv20 上位(无转职则 Lv20/当前职业上限),
   * cap 截断。与 options 无关 - 它是天花板,不是某个训练计划的结果。
   */
  maxed: StatLine;
}

export interface ProjectionOptions {
  /** 每章期望升级数,默认 1。 */
  levelsPerChapter?: number;
  /** 转职时机:基础职业达到该等级即转,默认 20。 */
  promoteAt?: number;
}

type GrownStat = keyof StatLine;

const GROWN_STATS: readonly GrownStat[] = ["hp", "str", "skl", "spd", "def", "res", "lck"];

/** Level cap every GBA FE class shares; the class table carries no per-class value. */
const MAX_LEVEL = 20;

/** Tolerance for fractional-level comparisons; binary floats make `0.1` sums drift. */
const EPSILON = 1e-9;

// ----------------------------------------------------------------------- trace

/**
 * `extractEventTrace` pays a full event-script walk and `ParsedRom` is
 * immutable, so the trace is cached per handle rather than re-walked on every
 * `projectUnits` call.
 */
const traceCache = new WeakMap<ParsedRom, EventTrace>();

function traceOf(parsed: ParsedRom): EventTrace {
  const cached = traceCache.get(parsed);
  if (cached !== undefined) return cached;
  const trace = extractEventTrace(
    parsed.rom,
    parsed.layout,
    parsed.chapters,
    parsed.condSlots,
    parsed.eventScripts,
  );
  traceCache.set(parsed, trace);
  return trace;
}

// --------------------------------------------------------------- join chapters

/**
 * unit id -> earliest play-order position at which it joins the player's
 * army. See the module doc for the semantics; appearances come from the
 * shared collector in `analysis/appearances.ts`.
 */
function buildJoinPositions(parsed: ParsedRom, trace: EventTrace): Map<number, number> {
  const best = new Map<number, number>();
  for (const a of collectAppearances(parsed, trace)) {
    if (a.side !== "player") continue;
    if (a.source !== "placement" && a.source !== "recruit") continue;
    // Off every known story path: there is no chapter slot to project from.
    const position = parsed.playOrder.position.get(a.mapIndex);
    if (position === undefined) continue;
    const current = best.get(a.unitId);
    if (current === undefined || position < current) best.set(a.unitId, position);
  }
  return best;
}

// ----------------------------------------------------------------- promotion

/**
 * Class ids that are the promoted half of a base/promoted pair. The same rule
 * as `promotedClassIdsOf` in `load.ts`, duplicated because `load.ts` does not
 * export it: `promotesToClassId` links the pair **both ways**, so the tie is
 * broken by `sortOrder` - the higher value is the promoted side.
 */
function promotedClassIds(classes: readonly UnitClass[]): Set<number> {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const promoted = new Set<number>();
  for (const c of classes) {
    const target = byId.get(c.promotesToClassId);
    if (target && target.sortOrder < c.sortOrder) promoted.add(c.id);
  }
  return promoted;
}

/** Base class id -> the class it promotes into, for classes that have one. */
function buildPromotionTargets(classes: readonly UnitClass[]): Map<number, UnitClass> {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const promoted = promotedClassIds(classes);
  const targets = new Map<number, UnitClass>();
  for (const c of classes) {
    if (!promoted.has(c.id)) continue;
    const base = byId.get(c.promotesToClassId);
    // A promoted class whose reverse link points at another promoted class is
    // a third tier; the link still names *its* base, so the map stays correct.
    if (base !== undefined && base.id !== c.id) targets.set(base.id, c);
  }
  return targets;
}

// ----------------------------------------------------------------- simulation

interface SimContext {
  growths: Readonly<Record<GrownStat, number>>;
  classById: ReadonlyMap<number, UnitClass>;
  targets: ReadonlyMap<number, UnitClass>;
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
function capAt(state: SimState, cls: UnitClass | undefined): void {
  if (cls === undefined) return; // class id outside the table: no caps to apply
  for (const s of GROWN_STATS) {
    // The cap row's seventh field is con, not luck (same order as `bases`):
    // luck has no class cap, exactly like it has no promotion bonus.
    if (s === "lck") continue;
    state.stats[s] = Math.min(state.stats[s], cls.caps[s]);
  }
}

function applyPromotion(state: SimState, target: UnitClass): void {
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

function initState(unit: Unit, cls: UnitClass | undefined): SimState {
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
 * under the new ones.
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
      growBy(state, remaining, ctx);
      state.level += remaining;
      capAt(state, ctx.classById.get(state.classId));
      remaining = 0;
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
function maxedStats(unit: Unit, ctx: SimContext): StatLine {
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
export function projectUnits(parsed: ParsedRom, opts: ProjectionOptions = {}): UnitProjection[] {
  const levelsPerChapter = opts.levelsPerChapter ?? 1;
  const promoteAt = opts.promoteAt ?? MAX_LEVEL;

  const classById = new Map(parsed.classes.map((c) => [c.id, c]));
  const targets = buildPromotionTargets(parsed.classes);
  const joins = buildJoinPositions(parsed, traceOf(parsed));
  // Non-playable rows (a chain's terminal transition stop) pass no chapter,
  // so they grant no levels and emit no points.
  const playable = parsed.playOrder.steps.filter((s) => s.playable);

  const projections: UnitProjection[] = [];
  for (const unit of parsed.units) {
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
    classLine.push({ classId: unit.classId, name: cls?.name ?? unit.className });
    const target = unit.isPromotedClass ? undefined : targets.get(unit.classId);
    if (target !== undefined) classLine.push({ classId: target.id, name: target.name });

    const state = initState(unit, cls);
    // Already at or past the threshold on join: promote on the spot.
    if (!state.promoted && state.level >= promoteAt && target !== undefined) {
      applyPromotion(state, target);
    }

    const points: ProjectionPoint[] = [];
    if (joinPosition !== null) {
      // The join chapter itself is the baseline point: starting stats, no growth.
      points.push(snapshot(state, joinPosition));
      for (const step of playable) {
        if (step.order <= joinPosition) continue;
        advance(state, levelsPerChapter, ctx);
        points.push(snapshot(state, step.order));
      }
    }

    projections.push({
      unitId: unit.id,
      name: unit.name,
      joinPosition,
      classLine,
      points,
      maxed: maxedStats(unit, ctx),
    });
  }

  projections.sort(
    (a, b) => (a.joinPosition ?? Infinity) - (b.joinPosition ?? Infinity) || a.unitId - b.unitId,
  );
  return projections;
}
