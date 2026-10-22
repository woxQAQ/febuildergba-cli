/**
 * Per-chapter experience budget: how much combat exp a chapter offers, the
 * resource pool behind "who is worth training". Pure derivation over the
 * extract db ({@link ExpCurveInput}); nothing here is persisted.
 *
 * ## The formula and its sources
 *
 * FE6/7/8 share one exp engine. Three source families, cross-checked:
 *
 *   - **SF**: Serenes Forest "Calculations" pages (community reference),
 *     one per game:
 *       https://serenesforest.net/binding-blade/miscellaneous/calculations/
 *       https://serenesforest.net/blazing-sword/miscellaneous/calculations/
 *       https://serenesforest.net/the-sacred-stones/miscellaneous/calculations/
 *   - **DEComp**: the FE8U decomp, FireEmblemUniverse/fireemblem8u,
 *     `src/bmbattle.c`: `GetUnitExpLevel` / `GetUnitRoundExp` /
 *     `GetUnitPowerLevel` / `GetUnitClassKillExpBonus` / `GetUnitKillExpBonus`
 *     / `GetBattleUnitExpGain`. Authoritative where it and SF disagree.
 *   - **FEB**: FEBuilderGBA's `@CLASS_POWER` tooltip (InputFormRef.cs:12387),
 *     which restates the same three-line formula per version and names the
 *     class-record byte `+26` (経験値補正値) as the class power - the byte
 *     `tables/classes.ts` reads as `classPower`.
 *
 * The engine formula (DEComp, SF agrees in structure):
 *
 *     expLevel(c)  = c.level + (c.promoted ? 20 : 0)
 *     powerLevel(c) = c.level * c.classPower
 *                     + (c.promoted && link != 0 ? 20 * power(link) : 0)
 *     roundExp     = max(0, 31 - (expLevel(actor) - expLevel(target)))
 *                    / actor.classPower              -- truncated division
 *     killBonus    = 20 + (powerLevel(target) - powerLevel(actor),
 *                          mode-coefficient variant below)
 *                    + (target.thief ? 20 : 0) + (target.boss ? 40 : 0)
 *                    + (FE8 && target is Entombed ? 40 : 0), clamped >= 0
 *     battleExp    = clamp(roundExp + killBonus, 1, 100),
 *                    or 0 when the target's class is noExp-flagged
 *
 * `link` is the class-record +5 field (promotesToClassId), which for a
 * promoted class points back at its base class - so "Class bonus B" is
 * `20 * power(base class)`: SF's vanilla lists (40 for Bishop/Valkyrie/
 * Assassin/Rogue, 60 for other promoted) are exactly that rule evaluated on
 * base classes with power 2 vs 3.
 *
 * ## The mode coefficient (per-version difference)
 *
 * When the kill base (`powerLevel(target) - powerLevel(actor)`) is <= 0,
 * some modes halve the *actor's* term instead (`target - trunc(actor/2)`):
 *
 *   - FE6: never - SF's FE6 formula has no coefficient.
 *   - FE7: Eliwood/Hector **Normal** and the Link Arena (SF-FE7); modelled
 *     here as every difficulty except `hard`.
 *   - FE8: never. The decomp's `GetUnitKillExpBonus` reaches the halving
 *     branch only when `chapterModeIndex == 1 && !(gameStateBits & 0x40)`,
 *     and `chapterModeIndex` is a save-file field the extract does not carry:
 *     `SaveMenuWriteNewGame` passes a literal mode of 1 to `WriteNewGameSave`
 *     for every difficulty, so the game runs the *unhalved* branch except on
 *     chapters 0-8. We model the whole game rather than those eight chapters
 *     - see {@link EXP_CURVE_ASSUMPTIONS}.
 *
 * ## What the budget measures, and what it used to measure
 *
 * Enemies come from `derived_unit_stats` (`data.unitStats` - simulator output
 * materialized by extraction), which already resolves each appearance's level
 * under each difficulty.
 *
 * The budget is a measurement **for a stated player level**: given an attacker
 * of level {@link ExpCurveOptions.actorLevel} in a class of power
 * {@link ExpCurveOptions.actorClassPower} (promoted or not, by
 * {@link ExpCurveOptions.actorPromoted}), how much exp does this chapter's
 * enemy set hand out? The level is an input, not an assumption, so the level
 * terms in the formula do not cancel and each enemy's grade, class power and
 * boss/thief/mummy flags move the result independently.
 *
 * An earlier version fixed the attacker at the enemy's own level, class power
 * and promotion status - "parity" - which made each term of the formula cancel
 * against itself: `roundExp` collapsed to `31 / classPower` and
 * `powerLevel(target) - powerLevel(actor)` to 0, leaving
 * `battleExp == 31 / classPower + 20` for every enemy. With `classPower == 3`
 * on 103 of this ROM's 127 classes, that is ~30.3 exp per enemy whatever the
 * enemy is, so `totalExpAtParity` divided by `enemyCount` printed ~30 on 90 of
 * 144 rows and the "budget" was a restatement of the enemy count. Measuring a
 * chapter by fighting it with itself is not a measurement, and the name hid
 * that. {@link ChapterExpBudget} still carries the enemy count, which was the
 * part that was real.
 *
 * Reinforcements are counted: every enemy a reachable event load brings
 * (`source === "event"`) is exp on the table, listed separately as
 * {@link ChapterExpBudget.eventLoadEnemyCount}. The caveats of the reach walk
 * apply - a reached script is not a fired script, and a block loaded several
 * times (per-turn reinforcement loops) is counted once, undercounting grindy
 * chapters. See `EXP_CURVE_ASSUMPTIONS`.
 */

import type { ExpCurveInput } from "./data.ts";
import type { GameVersion } from "../model/game.ts";
import type { ClassRecord } from "../model/records.ts";
import type { Difficulty, UnitStatRow } from "../model/stats.ts";
import { DIFFICULTIES } from "../model/stats.ts";

// ----------------------------------------------------------------- constants
// Every value cited; see the module doc for the source abbreviations.

/**
 * Base of the damage-exp term. DEComp `GetUnitRoundExp` (`31 - levelDelta`);
 * SF all three versions.
 */
const DAMAGE_BASE_EXP = 31;

/**
 * Effective-level bonus of a promoted class (SF "Class bonus A"). DEComp
 * `GetUnitExpLevel`: `+20` when `CA_PROMOTED`.
 */
const PROMOTED_EFFECTIVE_LEVEL = 20;

/**
 * "Class bonus B" = this times the linked base class's power. DEComp
 * `GetUnitPowerLevel`: `+20 * GetClassData(promotion)->classRelativePower`.
 */
const PROMOTED_POWER_FACTOR = 20;

/** Flat term of the kill bonus. DEComp `GetUnitKillExpBonus`; SF "+20". */
const KILL_BASE_EXP = 20;

/**
 * Kill bonus against a class with the boss attribute. DEComp
 * `GetUnitClassKillExpBonus` (`CA_BOSS` -> +40); SF "Boss bonus".
 * Class record `+41` bit `0x80` (config key `18`, `tables/classFlags.ts`).
 */
const BOSS_KILL_BONUS = 40;
const BOSS_FLAG_MASK = 0x80; // ability byte +41

/**
 * Kill bonus against a thief-flagged class. DEComp (`CA_THIEF` -> +20); SF
 * "Thief bonus" (FE6: Thief; FE7: Thief/Assassin; FE8: Thief/Rogue/Assassin -
 * all carried by the one attribute bit). Class record `+40` bit `0x08`
 * (config key `04` thiefSkill).
 */
const THIEF_KILL_BONUS = 20;
const THIEF_FLAG_MASK = 0x08; // ability byte +40

/**
 * FE8-only extra against Entombed (マミー). DEComp
 * `GetUnitClassKillExpBonus` (`CLASS_ENTOUMBED == 0x53`); FEB's FE8 tooltip
 * line マミー修正. The class id is a vanilla constant - a hack that reorders
 * its class table defeats the check (assumption, see meta).
 */
const MUMMY_KILL_BONUS = 40;
const ENTOMBED_CLASS_ID_FE8 = 0x53;

/**
 * Classes with this bit give no exp at all. DEComp `GetBattleUnitExpGain`
 * returns 0 when the target has `CA_NEGATE_LETHALITY` (class record `+43`
 * bit `0x01`, config key `31` noExp).
 */
const NO_EXP_FLAG_MASK = 0x01; // ability byte +43

/** Exp is clamped to this range per combat. DEComp `GetBattleUnitExpGain`. */
const EXP_MIN = 1;
const EXP_MAX = 100;

/** Exp points per level-up; universal engine constant. */
export const EXP_PER_LEVEL = 100;

// ------------------------------------------------------------------ combatant

/**
 * The exp-relevant profile of one side of a combat. Built from a class plus a
 * resolved level; never stored, computed per evaluation.
 */
export interface CombatantProfile {
  level: number;
  /** Class record `+26`; values below 1 are a corrupt/empty class slot. */
  classPower: number;
  promoted: boolean;
  /**
   * Power of the class the `+5` field links to (the base class, for a
   * promoted class). 0 when unpromoted or the link is empty - mirroring the
   * engine's `pClassData->promotion != 0` guard.
   */
  linkedClassPower: number;
  boss: boolean;
  thief: boolean;
  /** FE8 Entombed check; always false in FE6/7. */
  mummy: boolean;
  /** Class gives no exp when killed (`+43` bit `0x01`). */
  noExp: boolean;
}

/**
 * Build a combatant from a class at a resolved level. `promoted` follows the
 * caller's evidence (unitStats uses the unit's or the class's promoted bit);
 * the flags come from the class's raw ability bytes, so no `config/data`
 * dependency.
 */
export function combatantOf(
  cls: ClassRecord,
  level: number,
  promoted: boolean,
  classById: ReadonlyMap<number, ClassRecord>,
  game: GameVersion,
): CombatantProfile {
  const linked =
    promoted && cls.promotesToClassId !== 0 ? classById.get(cls.promotesToClassId) : undefined;
  return {
    level,
    classPower: cls.classPower,
    promoted,
    linkedClassPower: linked?.classPower ?? 0,
    boss: (cls.abilityFlags[1] & BOSS_FLAG_MASK) !== 0,
    thief: (cls.abilityFlags[0] & THIEF_FLAG_MASK) !== 0,
    mummy: game.startsWith("FE8") && cls.id === ENTOMBED_CLASS_ID_FE8,
    noExp: (cls.abilityFlags[3] & NO_EXP_FLAG_MASK) !== 0,
  };
}

// -------------------------------------------------------------------- formula

/** C integer division (truncation toward zero); SF: "decimals rounded down". */
function cDiv(n: number, d: number): number {
  return Math.trunc(n / d);
}

function expLevel(c: CombatantProfile): number {
  return c.level + (c.promoted ? PROMOTED_EFFECTIVE_LEVEL : 0);
}

function powerLevel(c: CombatantProfile): number {
  return c.level * c.classPower + c.linkedClassPower * PROMOTED_POWER_FACTOR;
}

/**
 * Whether this game/difficulty halves the actor's power-level term when the
 * kill base would be <= 0. Per-version rules in the module doc; the FE8 halving
 * branch is unreachable here because it needs a save-file field, not ROM data.
 */
function usesModeCoefficient(game: GameVersion, difficulty: Difficulty): boolean {
  if (game.startsWith("FE6")) return false;
  if (game.startsWith("FE7")) return difficulty !== "hard";
  return false;
}

/** DEComp `GetUnitRoundExp`: clamped before the division, never negative. */
export function damageExp(actor: CombatantProfile, target: CombatantProfile): number {
  const raw = DAMAGE_BASE_EXP - (expLevel(actor) - expLevel(target));
  if (raw <= 0 || actor.classPower < 1) return 0;
  return cDiv(raw, actor.classPower);
}

/**
 * DEComp `GetUnitKillExpBonus` for a kill (`target.curHP == 0` pre-satisfied).
 * The Silencer/Assassinate multiplier is deliberately excluded - a random
 * proc is not a chapter resource (assumption, see meta).
 */
export function killExpBonus(
  actor: CombatantProfile,
  target: CombatantProfile,
  game: GameVersion,
  difficulty: Difficulty,
): number {
  const targetPL = powerLevel(target);
  const actorPL = powerLevel(actor);
  let diff = targetPL - actorPL;
  if (diff <= 0 && usesModeCoefficient(game, difficulty)) {
    diff = targetPL - cDiv(actorPL, 2);
  }
  let bonus = KILL_BASE_EXP + diff;
  if (target.thief) bonus += THIEF_KILL_BONUS;
  if (target.boss) bonus += BOSS_KILL_BONUS;
  if (target.mummy) bonus += MUMMY_KILL_BONUS;
  return Math.max(0, bonus);
}

/**
 * Exp for killing `target` with `actor`, assuming the hit landed
 * (`nonZeroDamage`); DEComp `GetBattleUnitExpGain`. 0 for noExp classes.
 */
export function battleExp(
  actor: CombatantProfile,
  target: CombatantProfile,
  game: GameVersion,
  difficulty: Difficulty,
): number {
  if (target.noExp) return 0;
  const total = damageExp(actor, target) + killExpBonus(actor, target, game, difficulty);
  return Math.min(EXP_MAX, Math.max(EXP_MIN, total));
}

// --------------------------------------------------------------------- budget

export interface ChapterExpBudget {
  mapIndex: number;
  /** 1-based play-order position (`derived_play_order`). */
  position: number;
  difficulty: Difficulty;
  /**
   * Enemies counted into the budget: placement-block and event-load
   * appearances, noExp-flagged classes excluded. Event loads (reinforcements
   * and other mid-chapter arrivals) are included - they are exp on the table -
   * and listed separately in {@link eventLoadEnemyCount}.
   */
  enemyCount: number;
  /** Counted enemies from the chapter's initial placement block. */
  initialEnemyCount: number;
  /** Counted enemies from event loads (reinforcements etc.). */
  eventLoadEnemyCount: number;
  /**
   * Modal class power of the counted enemies, `null` when there are none - the
   * reference power a "typical enemy of this chapter" has.
   */
  typicalClassPower: number | null;
  /**
   * Total exp a unit of the stated {@link ExpCurveOptions.actorLevel} and
   * {@link ExpCurveOptions.actorClassPower} earns by killing every counted
   * enemy in this chapter. Each enemy contributes its own exp, so the total
   * moves with the enemies' levels, powers and boss/thief/mummy flags.
   */
  totalExp: number;
  /** {@link totalExp} in level-ups (`/ 100`). */
  expectedLevels: number;
}

export interface ExpCurveMeta {
  game: GameVersion;
  /**
   * The attacker the budget was measured for, echoed as resolved (defaults
   * applied). The numbers in `budgets` move by a factor of two across this
   * vector - `--actor-level` more than any other - so a consumer that quotes a
   * `totalExp` has to be able to read back what produced it.
   */
  actor: {
    level: number;
    classPower: number;
    promoted: boolean;
  };
  /** Difficulties present in `budgets`, in ascending order. */
  difficulties: readonly Difficulty[];
  /** Where every formula constant comes from; see the module doc. */
  sources: readonly string[];
  /**
   * Every modelling decision that is NOT read from the ROM or the cited
   * formula - the things a reviewer should not have to guess.
   */
  assumptions: readonly string[];
}

export interface ExpCurveResult {
  budgets: ChapterExpBudget[];
  meta: ExpCurveMeta;
}

const EXP_CURVE_SOURCES: readonly string[] = [
  "https://serenesforest.net/binding-blade/miscellaneous/calculations/ (FE6 experience)",
  "https://serenesforest.net/blazing-sword/miscellaneous/calculations/ (FE7 experience)",
  "https://serenesforest.net/the-sacred-stones/miscellaneous/calculations/ (FE8 experience)",
  "https://github.com/FireEmblemUniverse/fireemblem8u src/bmbattle.c "
    + "(GetUnitExpLevel/GetUnitRoundExp/GetUnitPowerLevel/GetUnitKillExpBonus/GetBattleUnitExpGain)",
  "FEBuilderGBA InputFormRef.cs @CLASS_POWER tooltip; ClassForm.Designer.cs J_26 (class +26)",
];

const EXP_CURVE_ASSUMPTIONS: readonly string[] = [
  "Reinforcements count: every enemy in a reachable event load is budgeted. "
    + "A reached script is not a fired script (conditional/turn events may never "
    + "trigger), and a block loaded repeatedly is counted once - grindy chapters "
    + "are undercounted.",
  "Silencer/Assassinate multiplier excluded (SF-FE7 ~1.8, DEComp-FE8 x2): a "
    + "random proc, not a chapter resource.",
  "FE8 class-id special cases not modelled except the Entombed bonus: Gorgon "
    + "Egg fixed 50 / Demon King kill 0 / Phantom attacker 0 "
    + "(ModifyUnitSpecialExp) - vanilla class ids do not survive hacks.",
  "FE8 mode coefficient not applied: the decomp's halving branch needs "
    + "chapterModeIndex == 1, a save-file field no extract carries "
    + "(SaveMenuWriteNewGame writes a literal 1 for every difficulty). The "
    + "branch is reachable only on chapters 0-8; chapters 9+ are modelled, "
    + "where the engine always uses the unhalved form.",
  "FE7 mode coefficient applied on easy/normal, not hard (SF-FE7: Eliwood "
    + "Normal, Hector Normal, Link Arena).",
  "FE6 has no difficulty level adjustment in its map settings, so its three "
    + "difficulty budgets are identical.",
  "Entombed is detected by the vanilla FE8U class id 0x53; a hack that moves "
    + "class ids loses the mummy bonus.",
  "Staff/dance/rescue exp is not part of the budget - it is not enemy-derived.",
  "Enemy attribution inherits the unitStats reach walk: a load block every "
    + "chapter can reach is budgeted in every such chapter.",
  "Level-underflowed enemies (easy/normal penalty pushes a level below 0; "
    + "the game wraps them to maxed enemies) are evaluated at level 0, the "
    + "lowest level the formula accepts.",
  "The attacker is one class power, so a promoted attacker's 'class bonus B' "
    + "term (`20 * power(base class)`) is not modelled - it needs the base/"
    + "promoted pair, not a single power. A promoted attacker therefore "
    + "understates its own power level, which raises the exp it is credited "
    + "with.",
  "Every counted enemy is assumed killed by the stated attacker: weapon "
    + "availability, hit rate and the attacker's own survival are not modelled. "
    + "This is an opportunity index for the counted enemy set, not a strict "
    + "upper bound on actual play: partial events can omit enemies, conditional "
    + "loads may not occur, and non-enemy exp sources are excluded.",
];

export interface ExpCurveOptions {
  /** Restrict to one difficulty; default emits all three. */
  difficulty?: Difficulty;
  /**
   * Level of the hypothetical attacker the budget is measured for. The
   * enemy's own level is the target side's; this is the actor's, and the two
   * being different is what makes `roundExp` a measurement rather than a
   * constant. Defaults to {@link STANDARD_ACTOR_LEVEL}.
   */
  actorLevel?: number;
  /**
   * `classPower` of the attacker's class. Defaults to
   * {@link STANDARD_ACTOR_CLASS_POWER}, which is the modal value across this
   * ROM's classes (103 of 127).
   */
  actorClassPower?: number;
  /** Whether the attacker's class is promoted (`expLevel` +20). */
  actorPromoted?: boolean;
}

/**
 * Default attacker level. Unpromoted classes cap at 20 and promotion resets to
 * 1, so 20 is the highest level the default attacker can be before promoting -
 * the conservative end of the range in which a chapter is fought.
 */
const STANDARD_ACTOR_LEVEL = 20;

/**
 * Default attacker class power: the modal `+26` across classes, so the default
 * is the common class rather than a special one.
 */
const STANDARD_ACTOR_CLASS_POWER = 3;

/** Modal class power of the counted enemies; `null` when empty. */
function typicalClassPowerOf(powers: readonly number[]): number | null {
  if (powers.length === 0) return null;
  const counts = new Map<number, number>();
  for (const p of powers) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best = powers[0] as number;
  let bestCount = 0;
  for (const [power, count] of counts) {
    // Ties break to the *lower* power: the conservative reading of what a
    // typical enemy is worth.
    if (count > bestCount || (count === bestCount && power < best)) {
      best = power;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The per-chapter exp budget for every playable chapter, one entry per
 * difficulty (FE6's three are identical - see assumptions).
 */
export function computeExpCurve(data: ExpCurveInput, opts: ExpCurveOptions = {}): ExpCurveResult {
  const rows = data.unitStats;
  const classById = new Map(data.classes.map((c) => [c.id, c]));
  const game = data.game;
  const difficulties = opts.difficulty === undefined ? DIFFICULTIES : [opts.difficulty];

  // The attacker is stated by the caller, not mirrored from the target: the
  // whole point of the budget is that the two sides differ. `linkedClassPower`
  // is left at 0 - the caller supplies one class power rather than a
  // base/promoted pair, so the promoted "class bonus B" term is not modelled;
  // it is listed in the assumptions.
  const actor: CombatantProfile = {
    level: opts.actorLevel ?? STANDARD_ACTOR_LEVEL,
    classPower: opts.actorClassPower ?? STANDARD_ACTOR_CLASS_POWER,
    promoted: opts.actorPromoted ?? false,
    linkedClassPower: 0,
    boss: false,
    thief: false,
    mummy: false,
    noExp: false,
  };

  // (mapIndex, difficulty) -> counted enemy rows, with the class resolved once
  // here rather than looked up again at consumption.
  const byChapter = new Map<string, { row: UnitStatRow; cls: ClassRecord }[]>();
  for (const row of rows) {
    if (row.side !== "enemy") continue;
    const cls = classById.get(row.classId);
    if (cls === undefined) continue;
    // noExp classes give nothing and corrupt the count; class power < 1 is a
    // corrupt slot the formula cannot divide by.
    if ((cls.abilityFlags[3] & NO_EXP_FLAG_MASK) !== 0 || cls.classPower < 1) continue;
    const key = `${row.mapIndex}|${row.difficulty}`;
    const list = byChapter.get(key);
    if (list === undefined) byChapter.set(key, [{ row, cls }]);
    else list.push({ row, cls });
  }

  const budgets: ChapterExpBudget[] = [];
  for (const step of data.playOrder.steps) {
    if (!step.playable) continue;
    for (const difficulty of difficulties) {
      const enemies = byChapter.get(`${step.mapIndex}|${difficulty}`) ?? [];
      let totalExp = 0;
      let initialEnemyCount = 0;
      const powers: number[] = [];
      for (const { row, cls } of enemies) {
        // A level that underflowed below 0 wraps to a maxed enemy in the game
        // (see extract/unitStats.ts), so no formula input survives that
        // reading. Clamp to 0: the lowest level the formula can be evaluated
        // at, which is the reading that neither invents a level nor discards
        // the enemy.
        const level = row.levelUnderflow ? 0 : row.level;
        // The target side is the enemy as the extract resolved it; boss/thief/
        // mummy flags only ever apply to the target.
        const enemy = combatantOf(cls, level, row.promoted, classById, game);
        totalExp += battleExp(actor, enemy, game, difficulty);
        powers.push(cls.classPower);
        if (row.source === "placement") initialEnemyCount++;
      }
      budgets.push({
        mapIndex: step.mapIndex,
        position: step.order,
        difficulty,
        enemyCount: enemies.length,
        initialEnemyCount,
        eventLoadEnemyCount: enemies.length - initialEnemyCount,
        typicalClassPower: typicalClassPowerOf(powers),
        totalExp,
        expectedLevels: totalExp / EXP_PER_LEVEL,
      });
    }
  }

  return {
    budgets,
    meta: {
      game,
      actor: { level: actor.level, classPower: actor.classPower, promoted: actor.promoted },
      difficulties,
      sources: EXP_CURVE_SOURCES,
      assumptions: EXP_CURVE_ASSUMPTIONS,
    },
  };
}
