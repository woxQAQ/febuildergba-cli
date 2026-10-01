/**
 * Enemy stat projection: turn a placement record into the speed / constitution
 * / attack speed the game will actually give that enemy.
 *
 * ## Why this exists
 *
 * `economy-plan.ts` has to answer "can this unit carry this weapon and still
 * double?" - and doubling is decided by `|attackerAS - defenderAS| >= 4`. The
 * player's half of that is computed from the unit and class tables. The
 * enemy's half used to be a hard-coded constant, because FE8 has no enemy
 * table and it was not obvious where an enemy's stats come from.
 *
 * They come from four places, and all four are now read from the ROM:
 *
 *   1. **Class bases** - `class + 0x0B..0x11` (hp, str, skl, spd, def, res, con).
 *   2. **Character deltas** - the placement record's `unitId` indexes the
 *      character table, whose `+12..+19` are *signed* offsets from the class
 *      base. This applies to enemies exactly as it does to the player.
 *   3. **Autolevel** - `Event2C_LoadUnits` (`0x0800FB84`) ends up in
 *      `AutolevelUnit @ 0x08018120` or `AutolevelRealistic @ 0x08018160`,
 *      depending on flags and the character id (see {@link autolevelRoutine}).
 *   4. **Equipment** - the record's four item bytes at `+12..15`, through the
 *      item table's weight byte at `+23`.
 *
 * ## The autolevel gate, read off the ROM
 *
 * `0x08017C10` is the first thing the loader does with the record:
 *
 * ```
 * ldrb r1, [r6, #3]     ; r1 = record[+3]
 * movs r0, #1
 * ands r0, r1           ; GROW = +3 & 1
 * cmp  r0, #0
 * beq  #0x8017cb8       ; GROW == 0 -> no autolevel at all
 * ```
 *
 * `+3` bit 0 is the field the editor labels 成長率 ("成長させない" / "クラス依存"),
 * and it is a **master switch** that is tested *before* the allegiance test.
 * 11% of this ROM's enemy records have it clear, so skipping this check would
 * overstate their stats.
 *
 * The gate for the extra promoted round is inside `AutolevelUnit` itself
 * (`0x0801812E`: `movs r1,#0x80; lsls r1,r1,#1` = mask `0x100`), i.e.
 * `(char.abilityFlags[1] | class.abilityFlags[1]) & 0x01` - the editor's
 * 特性2 bit0, 上級クラス(武器S).
 *
 * ## Why the result is a band, not a number
 *
 * `GetAutoleveledStat @ 0x0802B9C4` is not arithmetic:
 *
 * ```
 * v = growth * count
 * q8  = v >> 3                    ; trunc(v/8)
 * bl  NextRN_N                    ; + rand(0, q8-1)
 * q16 = v >> 4                    ; trunc(v/16)
 * x   = v + rand - q16
 * bl  GetStatIncrease             ; Roll1RN decides the last point
 * ```
 *
 * The mean is stable, the last point is not. So every stat here carries
 * `{ lo, hi, mean }`; `mean` is what the reports use and the band is what says
 * "this number is not exact". This also means autoleveling **burns random
 * numbers**, which matters to the RNG assistant in `mgba/`.
 *
 * See `docs/battle-math.md` §3.20.
 */

import type { GameLayout } from '../data/layouts.ts';
import type { RomBuffer } from '../rom/RomBuffer.ts';
import type { Chapter, CondSlotInfo, PlacedUnit } from '../tables/chapters.ts';
import { collectPlacementSites } from '../tables/chapters.ts';
import type { UnitClass } from '../tables/classes.ts';
import type { EventScriptTable } from '../tables/eventScript.ts';
import type { Item } from '../tables/items.ts';
import type { Unit } from '../tables/units.ts';

// ─────────────────────────────────────────────────────────────────────────────
// The formula
// ─────────────────────────────────────────────────────────────────────────────

/** A stat that the RNG can nudge. `mean` is the usable value. */
export interface StatBand {
  /** Lowest value the RNG can produce. */
  lo: number;
  /** Highest value the RNG can produce. */
  hi: number;
  /** Expected value. */
  mean: number;
}

/**
 * `GetCurrentPromotedLevelBonus @ 0x08037B44`: `gChapterData[0x14] & 0x40`
 * (the hard-mode bit) selects **19**, otherwise **9**. A promoted unit gets
 * this many extra autolevel rounds on top of `level - 1`.
 */
export function promotedLevelBonus(hard: boolean): number {
  return hard ? 19 : 9;
}

/**
 * One `IncreaseUnitStatsByLevelCount` round, i.e. one pass of
 * `growth x count` through `GetAutoleveledStat`.
 *
 * `GetAutoleveledStat(growth, count)` computes `v = growth * count` and then
 * `x = v + rand(0, v/8 - 1) - v/16`; `GetStatIncrease` turns `x` into
 * `floor(x/100)` plus one more point with probability `(x % 100) / 100`.
 * So the reachable gains are `[floor(xMin/100), floor(xMax/100) + 1]`.
 */
export function autolevelBand(growth: number, count: number): StatBand {
  const v = growth * count;
  if (v <= 0) return { lo: 0, hi: 0, mean: 0 };
  const jitter = v >> 3; // NextRN_N(trunc(v/8)) returns 0 .. trunc(v/8)-1
  const shrink = v >> 4; // the v/16 the ROM subtracts back off
  const xMin = v - shrink;
  const xMax = v + Math.max(0, jitter - 1) - shrink;
  return {
    lo: Math.floor(xMin / 100),
    hi: Math.floor(xMax / 100) + 1,
    mean: (v - shrink + Math.max(0, jitter - 1) / 2) / 100,
  };
}

/**
 * Which autolevel routine `Event2C_LoadUnits` picks for a record.
 *
 * - `none` - `+3` bit 0 is clear: the record keeps its raw stats.
 * - `unit` - `AutolevelUnit @ 0x08018120`: `count = level - 1` (plus a promoted
 *   round of 9 / 19) through the **class's** `enemyGrowths`.
 * - `realistic` - `AutolevelRealistic @ 0x08018160`: `count = level - the
 *   character table's level`, then that many *simulated level-ups* through the
 *   **character's own** growths (`CheckForLevelUp @ 0x0802BA28` in a loop).
 *
 * The choice is made at `0x08017C36`: `(char.abilityFlags[1] |
 * class.abilityFlags[1]) & 0x80` forces `realistic`; otherwise a character id
 * above `0x40` gets `unit`, and everything else falls back to `realistic`.
 */
export type AutolevelRoutine = 'none' | 'unit' | 'realistic';

export function autolevelRoutine(
  grow: number,
  charFlags1: number,
  classFlags1: number,
  charId: number,
): AutolevelRoutine {
  if ((grow & 1) === 0) return 'none';
  if (((charFlags1 | classFlags1) & 0x80) !== 0) return 'realistic';
  return charId > 0x40 ? 'unit' : 'realistic';
}

// ─────────────────────────────────────────────────────────────────────────────
// Projecting one record
// ─────────────────────────────────────────────────────────────────────────────

export interface EnemySample {
  mapIndex: number;
  chapterNumber: number;
  /** File offset of the placement record, for cross-referencing the census. */
  addr: number;
  unitId: number;
  classId: number;
  className: string;
  level: number;
  /** `+3` bit 0: 0 = no autolevel, 1 = autolevel. */
  grow: number;
  routine: AutolevelRoutine;
  /** True when the promoted autolevel round applies (`abilityFlags[1] & 1`). */
  promoted: boolean;
  /** The class's own base speed (`class + 0x0E`). */
  classBaseSpd: number;
  /** The character table's signed speed delta (`+15`), 0 when unresolved. */
  unitSpdDelta: number;
  /** Final speed: class base + character delta + autolevel. */
  spd: StatBand;
  /** Constitution: class base + character delta. Never grows in FE8. */
  con: number;
  /**
   * The heaviest weapon weight in `+12..15`, or 0 when the record carries no
   * weapon. This is the **worst case** for the enemy and therefore the
   * best case for the player's doubling check; {@link weightFirst} is the
   * other convention, and the two differ by ~0.2 AS on average.
   */
  weight: number;
  /** The first weapon in the record, which is what the editor shows first. */
  weightFirst: number;
  /**
   * Attack speed `spd - max(0, weight - con)`. **Signed on purpose**: the
   * engine stores it in a signed byte and nothing clamps it, so a Gorgon Egg
   * carrying a tome really does sit below zero.
   */
  as: StatBand;
}

export interface EnemyProjectionContext {
  rom: RomBuffer;
  layout: GameLayout;
  eventScripts: EventScriptTable;
  chapters: readonly Chapter[];
  condSlots: readonly CondSlotInfo[];
  classes: readonly UnitClass[];
  units: readonly Unit[];
  items: readonly Item[];
  /** Hard mode changes only the promoted autolevel round (9 -> 19). */
  hard: boolean;
}

function shift(band: StatBand, by: number): StatBand {
  return { lo: band.lo + by, hi: band.hi + by, mean: band.mean + by };
}

/**
 * Project every enemy in one placement block.
 *
 * Records whose `classId` is 0 use the character's own class (that is what the
 * field means, not class id 0 - see `PlacedUnit.classId`). Records whose class
 * cannot be resolved are dropped rather than guessed at.
 */
export function projectBlock(
  ctx: EnemyProjectionContext,
  mapIndex: number,
  chapterNumber: number,
  units: readonly PlacedUnit[],
  classById: ReadonlyMap<number, UnitClass>,
  unitById: ReadonlyMap<number, Unit>,
  itemById: ReadonlyMap<number, Item>,
): EnemySample[] {
  const out: EnemySample[] = [];

  for (const record of units) {
    if (record.side !== 'enemy') continue;

    const unit = unitById.get(record.unitId);
    const classId = record.classId !== 0 ? record.classId : (unit?.classId ?? 0);
    const cls = classById.get(classId);
    if (cls === undefined) continue;

    const charFlags1 = unit?.abilityFlags[1] ?? 0;
    const classFlags1 = cls.abilityFlags[1];
    const promoted = ((charFlags1 | classFlags1) & 0x01) !== 0;
    const routine = autolevelRoutine(record.autolevel, charFlags1, classFlags1, record.unitId);

    // --- speed ---------------------------------------------------------
    const classBaseSpd = cls.bases.spd;
    const unitSpdDelta = unit?.stats.spd ?? 0;
    const base = classBaseSpd + unitSpdDelta;
    let gain: StatBand = { lo: 0, hi: 0, mean: 0 };
    if (routine === 'unit') {
      const rounds: StatBand[] = [];
      if (promoted) {
        rounds.push(autolevelBand(cls.enemyGrowths.spd, promotedLevelBonus(ctx.hard)));
      }
      rounds.push(autolevelBand(cls.enemyGrowths.spd, Math.max(0, record.level - 1)));
      gain = rounds.reduce(
        (acc, b) => ({ lo: acc.lo + b.lo, hi: acc.hi + b.hi, mean: acc.mean + b.mean }),
        { lo: 0, hi: 0, mean: 0 },
      );
    } else if (routine === 'realistic') {
      // One simulated level-up per level, with the character's own growths.
      // The mean is the same as `growth x count / 100`; the spread is binomial
      // (`n = count`, `p = growth/100`), so quote ~2 standard deviations.
      const count = Math.max(0, record.level - (unit?.level ?? 0));
      const growth = unit?.growths.spd ?? 0;
      const mean = (growth * count) / 100;
      const sd = Math.sqrt(count * (growth / 100) * (1 - growth / 100));
      const spread = Math.ceil(2 * sd);
      gain = { lo: Math.floor(mean) - spread, hi: Math.ceil(mean) + spread, mean };
    }

    // --- constitution ---------------------------------------------------
    const con = cls.bases.con + (unit?.stats.con ?? 0);

    // --- equipment ------------------------------------------------------
    let weight = 0;
    let weightFirst = 0;
    for (const id of record.items) {
      if (id === 0) continue;
      const item = itemById.get(id);
      if (item === undefined || !item.isWeapon) continue;
      if (weightFirst === 0) weightFirst = item.weight;
      weight = Math.max(weight, item.weight);
    }

    const spd = shift(gain, base);
    const penalty = Math.max(0, weight - con);
    out.push({
      mapIndex,
      chapterNumber,
      addr: record.addr,
      unitId: record.unitId,
      classId,
      className: cls.name,
      level: record.level,
      grow: record.autolevel,
      routine,
      promoted,
      classBaseSpd,
      unitSpdDelta,
      spd,
      con,
      weight,
      weightFirst,
      as: { lo: spd.lo - penalty, hi: spd.hi - penalty, mean: spd.mean - penalty },
    });
  }
  return out;
}

export interface EnemyStatsCollection {
  samples: EnemySample[];
  /** Enemy records dropped because their class id did not resolve. */
  unresolvedClass: number;
}

/** Every enemy in the ROM, with its projected stats. */
export function collectEnemyStats(ctx: EnemyProjectionContext): EnemyStatsCollection {
  const classById = new Map(ctx.classes.map((c) => [c.id, c]));
  const unitById = new Map(ctx.units.map((u) => [u.id, u]));
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));

  const samples: EnemySample[] = [];
  let unresolvedClass = 0;

  for (const chapter of ctx.chapters) {
    const sites = collectPlacementSites(
      ctx.rom,
      ctx.eventScripts,
      ctx.layout,
      chapter,
      ctx.condSlots,
    );
    for (const site of sites) {
      const enemies = site.units.filter((u) => u.side === 'enemy');
      samples.push(
        ...projectBlock(
          ctx,
          chapter.index,
          chapter.chapterNumber,
          site.units,
          classById,
          unitById,
          itemById,
        ),
      );
      // `projectBlock` drops records it cannot resolve; count them here so the
      // caller can tell "no enemies" apart from "the reader is broken".
      for (const record of enemies) {
        const unit = unitById.get(record.unitId);
        const classId = record.classId !== 0 ? record.classId : (unit?.classId ?? 0);
        if (!classById.has(classId)) unresolvedClass++;
      }
    }
  }
  return { samples, unresolvedClass };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summarising
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attack speed when the enemy swings the **first** weapon in its record rather
 * than the heaviest. Kept because "which weapon does the AI pick" is the one
 * input this projection cannot read off the ROM; the two conventions differ by
 * about 0.2 attack speed on average, which is the size of that unknown.
 */
export function attackSpeedFirstWeapon(sample: EnemySample): StatBand {
  const penalty = Math.max(0, sample.weightFirst - sample.con);
  return {
    lo: sample.spd.lo - penalty,
    hi: sample.spd.hi - penalty,
    mean: sample.spd.mean - penalty,
  };
}

export interface AsSummary {
  /** Records in the sample. */
  n: number;
  min: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  mean: number;
  /** Smallest `lo` / largest `hi` in the sample - the RNG's outer envelope. */
  bandLo: number;
  bandHi: number;
  /** Records whose attack speed lands below zero (weight > speed + con). */
  negative: number;
  /** Records that get no autolevel at all (`+3` bit 0 clear). */
  noAutolevel: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[at] as number;
}

export function summarizeAs(
  samples: readonly EnemySample[],
  pick: (sample: EnemySample) => StatBand = (sample) => sample.as,
): AsSummary {
  const values = samples.map((s) => pick(s).mean);
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((a, b) => a + b, 0);
  return {
    n: samples.length,
    min: sorted[0] ?? 0,
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? 0,
    mean: samples.length === 0 ? 0 : total / samples.length,
    bandLo: samples.length === 0 ? 0 : Math.min(...samples.map((s) => pick(s).lo)),
    bandHi: samples.length === 0 ? 0 : Math.max(...samples.map((s) => pick(s).hi)),
    negative: values.filter((v) => v < 0).length,
    noAutolevel: samples.filter((s) => s.routine === 'none').length,
  };
}
