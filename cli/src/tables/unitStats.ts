/**
 * The stats a unit actually enters a chapter with: a line-by-line port of
 * FEBuilderGBA's growth simulator. The ROM stores *inputs* (unit, class, level,
 * autolevel); the game computes seven numbers on map load, and upstream's model
 * is the only one known to agree with the game.
 *
 * Algorithm - `EventUnitSimUserControl.SetParam` (EventUnitSimUserControl.cs:51):
 *     classid = record.classId or, when 0, the unit's own class
 *     base    = unit +12..18 + class +11..16          (luck: unit only)
 *     growth  = record.autolevel ? class +27..33 : none
 *     lv      = record.level + difficulty adjustment
 *     if promoted(unit) or promoted(class): lv += 10
 *     if autolevel: start at level 1
 *     stats   = base + round(growth/100 * (lv - start))
 * `GrowSimulator.Grow` (GrowSimulator.cs:151) is the arithmetic; `SetSimUnit` /
 * `SetSimClass` the offsets, matching `tables/units.ts` `baseStats`/`growths`
 * and `tables/classes.ts` `bases`/`enemyGrowths`.
 *
 * The difficulty adjustment is a **level** delta, not a stat bonus: the three
 * nibbles of `chapters.difficulty_raw` feed `Grow` before it runs.
 * `@MAPSETTING_HARD_BOOST` (InputFormRef.cs:12129) and
 * `@MAPSETTING_NORMAL_MODE_LEVEL_PENALTY` (InputFormRef.cs:12133) say so, the
 * latter warning that a negative level underflows to the strongest enemy.
 * {@link UnitStatRow.levelUnderflow} records that instead of hiding it.
 *
 * Upstream quirks reproduced on purpose:
 *   - `Math.Round` is C# banker's rounding (half to even), not JS `Math.round`;
 *     {@link csRound} matches, and `grow/100*count` is ordered for bit-identical
 *     double arithmetic.
 *   - Clamp is `if (v > 256) v = 255`, so exactly 256 passes through - upstream's
 *     bug, kept so consumers match FEBuilderGBA.
 *   - Class stat *caps* are not applied (upstream clamps only at 255);
 *     `classes.cap_*` is there for a stricter consumer.
 *   - `con` is not in `GrowSimulator`; emitted as `unit delta + class base`, no
 *     growth, because the ROM data is there.
 *
 * Both appearances:
 *   - `placement` - chapter initial roster, condition slot 10 (「初めて普通の時の
 *     自軍配置」) / 11 (「難しい時の自軍配置」), i.e. player/ally only.
 *   - `event` - every unit a reachable instruction loads (where enemies are; in
 *     `dream-of-five.gba` ch1 the start event loads 31). Attribution walks
 *     `chapter_event_slots` -> scripts -> CALL closure ->
 *     `event_instructions.block_id`, the reach `chapter_recruits` uses.
 */

import type { Chapter, PlacedUnit, UnitSide } from "./chapters.ts";
import type { UnitClass } from "./classes.ts";
import type { EventTrace, TracedInstruction, TracedBlockUnit } from "./eventTrace.ts";
import type { Unit } from "./units.ts";

export type Difficulty = "easy" | "normal" | "hard";

/** Cheapest first. The order is the emit order, and it is stable. */
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "hard"];

/** The seven stats the simulator grows, plus constitution. */
export interface SimStats {
  hp: number;
  str: number;
  skl: number;
  spd: number;
  def: number;
  res: number;
  lck: number;
  con: number;
}

/** How a unit got onto the map. */
export type AppearanceSource = "placement" | "event";

export interface UnitStatRow {
  mapIndex: number;
  difficulty: Difficulty;
  source: AppearanceSource;
  /**
   * Identifies the block within the source: **0** = the normal placement block
   * (slot 10) and **1** = the hard one (slot 11) for `placement`; the
   * `load_blocks.id` for `event`.
   */
  sourceId: number;
  /** Row number within that block. */
  position: number;
  unitId: number;
  /** Resolved: a record's `classId` of 0 means the unit's own class. */
  classId: number;
  side: UnitSide;
  /** The level the record stores, before any adjustment. */
  shownLevel: number;
  /** The difficulty adjustment applied; always 0 for non-enemies. See the module doc. */
  levelDelta: number;
  /** `shownLevel + levelDelta`, deliberately not clamped. */
  level: number;
  /** `level < 0`: the game underflows and the enemy comes out maxed. See the module doc. */
  levelUnderflow: boolean;
  /** The record's grow flag: `false` means fixed stats, no growth at all. */
  autolevel: boolean;
  /** The level the growth actually ran to: `level + 10` when promoted. */
  growLevel: number;
  /** True when either the unit's or the class's `+41` bit 0 is set. */
  promoted: boolean;
  stats: SimStats;
}

export interface UnitStatContext {
  units: readonly Unit[];
  classes: readonly UnitClass[];
  chapters: readonly Chapter[];
  trace: EventTrace;
}

type GrownStat = "hp" | "str" | "skl" | "spd" | "def" | "res" | "lck";

const GROWN_STATS: readonly GrownStat[] = ["hp", "str", "skl", "spd", "def", "res", "lck"];

/**
 * C# `Math.Round(double)` - ties to the **even** neighbour. `Math.round` rounds
 * up, and a tie is reachable (growth 35 over 10 levels = 3.5). `Math.floor` (not
 * truncation) so negatives behave like C#.
 */
function csRound(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `GrowSimulator`'s clamp, including its `> 256` off-by-one. */
function clampStat(value: number): number {
  if (value > 256) return 255;
  if (value < 0) return 0;
  return value;
}

/**
 * `GrowSimulator.Grow`'s arithmetic for one appearance. `growth === null` is
 * `GrowOptionEnum.None`: base returned with no growth, still clamped.
 */
function growStats(
  base: Readonly<Record<GrownStat, number>>,
  growth: Readonly<Record<GrownStat, number>> | null,
  startLevel: number,
  targetLevel: number,
): Record<GrownStat, number> {
  const out = {} as Record<GrownStat, number>;
  const counts = growth !== null && startLevel < targetLevel;
  const span = targetLevel - startLevel;
  for (const key of GROWN_STATS) {
    // `((double)grow / 100) * count`, same association order as the C#.
    out[key] = counts ? base[key] + csRound((growth[key] / 100) * span) : base[key];
    out[key] = clampStat(out[key]);
  }
  return out;
}

/** Upstream's promoted test: `u8(record + 41) & 0x01`, on either table. */
function isPromoted(flags: readonly number[]): boolean {
  return ((flags[1] ?? 0) & 0x01) === 0x01;
}

/**
 * The level adjustment this chapter applies to `side` on `difficulty`. Only
 * enemies are adjusted (all three tooltips say 敵); a chapter with no difficulty
 * field (FE6) contributes 0.
 */
function levelDelta(chapter: Chapter, difficulty: Difficulty, side: UnitSide): number {
  if (side !== "enemy") return 0;
  if (difficulty === "hard") return chapter.hardBoost;
  if (difficulty === "normal") return -chapter.normalPenalty;
  return -chapter.easyPenalty;
}

/**
 * The placement block a difficulty uses: hard has its own (slot 11), the other
 * two share slot 10 - exactly what `GetChapterAllyUnitDataPointer` resolves.
 */
function placementBlock(chapter: Chapter, difficulty: Difficulty): readonly PlacedUnit[] {
  return difficulty === "hard" ? chapter.hardPlacements : chapter.placements;
}

/** `map_index` -> every script id a condition slot of that chapter can reach. */
function reachableScripts(trace: EventTrace): Map<number, Set<number>> {
  const calls = new Map<number, number[]>();
  for (const i of trace.instructions) {
    if (i.callScriptId === null) continue;
    const list = calls.get(i.scriptId);
    if (list === undefined) calls.set(i.scriptId, [i.callScriptId]);
    else list.push(i.callScriptId);
  }

  const out = new Map<number, Set<number>>();
  const queue: [number, number][] = [];
  for (const slot of trace.chapterSlots) {
    if (slot.scriptId === null) continue;
    let set = out.get(slot.mapIndex);
    if (set === undefined) {
      set = new Set<number>();
      out.set(slot.mapIndex, set);
    }
    if (!set.has(slot.scriptId)) {
      set.add(slot.scriptId);
      queue.push([slot.mapIndex, slot.scriptId]);
    }
  }

  while (queue.length > 0) {
    const [mapIndex, scriptId] = queue.shift() as [number, number];
    const set = out.get(mapIndex) as Set<number>;
    for (const called of calls.get(scriptId) ?? []) {
      if (set.has(called)) continue;
      set.add(called);
      queue.push([mapIndex, called]);
    }
  }
  return out;
}

/** Instructions grouped by the script they live in. */
function instructionsByScript(trace: EventTrace): Map<number, TracedInstruction[]> {
  const out = new Map<number, TracedInstruction[]>();
  for (const i of trace.instructions) {
    const list = out.get(i.scriptId);
    if (list === undefined) out.set(i.scriptId, [i]);
    else list.push(i);
  }
  return out;
}

function unitsByBlock(trace: EventTrace): Map<number, TracedBlockUnit[]> {
  const out = new Map<number, TracedBlockUnit[]>();
  for (const u of trace.loadBlockUnits) {
    const list = out.get(u.blockId);
    if (list === undefined) out.set(u.blockId, [u]);
    else list.push(u);
  }
  return out;
}

/**
 * Every `(chapter, difficulty, block, position)` appearance, with stats.
 * Deduplicated: a block referenced by two instructions of one chapter is one
 * appearance; `chapter_recruits` explains *why* a unit is there.
 */
export function buildUnitStats(ctx: UnitStatContext): UnitStatRow[] {
  const unitById = new Map(ctx.units.map((u) => [u.id, u]));
  const classById = new Map(ctx.classes.map((c) => [c.id, c]));
  const chapterByMap = new Map(ctx.chapters.map((c) => [c.index, c]));

  const rows: UnitStatRow[] = [];
  const seen = new Set<string>();

  const emit = (
    chapter: Chapter,
    difficulty: Difficulty,
    source: AppearanceSource,
    sourceId: number,
    position: number,
    unitId: number,
    placedClassId: number,
    shownLevel: number,
    side: UnitSide,
    autolevel: number,
  ): void => {
    const key = `${chapter.index}|${difficulty}|${source}|${sourceId}|${position}`;
    if (seen.has(key)) return;

    const unit = unitById.get(unitId);
    if (unit === undefined) return;
    const classId = placedClassId === 0 ? unit.classId : placedClassId;
    const cls = classById.get(classId);
    if (cls === undefined) return;
    seen.add(key);

    const promoted = isPromoted(unit.abilityFlags) || isPromoted(cls.abilityFlags);
    const delta = levelDelta(chapter, difficulty, side);
    const level = shownLevel + delta;
    const growLevel = promoted ? level + 10 : level;

    const base = {} as Record<GrownStat, number>;
    base.hp = unit.stats.hp + cls.bases.hp;
    base.str = unit.stats.str + cls.bases.str;
    base.skl = unit.stats.skl + cls.bases.skl;
    base.spd = unit.stats.spd + cls.bases.spd;
    base.def = unit.stats.def + cls.bases.def;
    base.res = unit.stats.res + cls.bases.res;
    // Luck has no class base (`GrowSimulator`: `sim_luck = unit_luck + 0`).
    base.lck = unit.stats.lck;

    const growth = autolevel === 1 ? cls.enemyGrowths : null;
    const grown = growStats(base, growth, autolevel === 1 ? 1 : unit.level, growLevel);

    rows.push({
      mapIndex: chapter.index,
      difficulty,
      source,
      sourceId,
      position,
      unitId,
      classId,
      side,
      shownLevel,
      levelDelta: delta,
      level,
      levelUnderflow: level < 0,
      autolevel: autolevel === 1,
      growLevel,
      promoted,
      stats: {
        hp: grown.hp,
        str: grown.str,
        skl: grown.skl,
        spd: grown.spd,
        def: grown.def,
        res: grown.res,
        lck: grown.lck,
        con: clampStat(unit.stats.con + cls.bases.con),
      },
    });
  };

  // Initial rosters: slot 10 (normal/easy) and slot 11 (hard).
  for (const chapter of ctx.chapters) {
    for (const difficulty of DIFFICULTIES) {
      const block = placementBlock(chapter, difficulty);
      const sourceId = difficulty === "hard" ? 1 : 0;
      for (const [position, p] of block.entries()) {
        emit(
          chapter,
          difficulty,
          "placement",
          sourceId,
          position,
          p.unitId,
          p.classId,
          p.level,
          p.side,
          p.autolevel,
        );
      }
    }
  }

  // Event loads, attributed to every chapter that can reach the instruction.
  const reach = reachableScripts(ctx.trace);
  const byScript = instructionsByScript(ctx.trace);
  const byBlock = unitsByBlock(ctx.trace);
  for (const [mapIndex, scriptIds] of reach) {
    const chapter = chapterByMap.get(mapIndex);
    if (chapter === undefined) continue;
    for (const scriptId of scriptIds) {
      for (const instruction of byScript.get(scriptId) ?? []) {
        if (instruction.blockId === null) continue;
        for (const u of byBlock.get(instruction.blockId) ?? []) {
          for (const difficulty of DIFFICULTIES) {
            emit(
              chapter,
              difficulty,
              "event",
              instruction.blockId,
              u.position,
              u.unitId,
              u.classId,
              u.level,
              u.side,
              u.autolevel,
            );
          }
        }
      }
    }
  }

  return rows;
}
