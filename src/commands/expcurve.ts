/**
 * `expcurve` command: how much combat exp each chapter's enemy set hands out to
 * a unit of a stated level. The formula, its sources and the reason the level
 * is an input rather than an assumption live in `analysis/expcurve.ts`; this is
 * the shell.
 */

import { expCurveOf } from "../analysis/service.ts";
import { DIFFICULTIES, type Difficulty } from "../model/stats.ts";
import { UsageError } from "./types.ts";
import { defineDbCommand } from "./types.ts";

/** Display rounding: levels are fractional by construction (exp / 100). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A flag value that must be a non-negative integer. Parsed here rather than in
 * the arg layer because only this command knows the field is numeric - the same
 * stance `text` takes on `--range`.
 */
function intFlag(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`--${flag} expects a non-negative integer, got "${value}"`);
  }
  return n;
}

/**
 * A flag value that must be a difficulty name. Parsed here so the command, not
 * `ResolvedFlags`, owns the narrow type - the same reason `--lang` is checked
 * in the arg layer and `--range` is not: only a command that can fail on the
 * value knows what its valid set is.
 */
function difficultyFlag(value: string): Difficulty {
  if (!DIFFICULTIES.includes(value as Difficulty)) {
    throw new UsageError(`--difficulty expects one of ${DIFFICULTIES.join(", ")}, got "${value}"`);
  }
  return value as Difficulty;
}

export const expcurve = defineDbCommand({
  name: "expcurve",
  input: "db",
  summary: "Show the exp each chapter's enemies give a stated attacker",
  description:
    "One row per playable chapter per difficulty: the counted enemies (initial "
    + "placements vs event loads/reinforcements), their modal class power, and "
    + "the total exp an attacker of the stated level and class power earns by "
    + "killing all of them (`totalExp`, and as level-ups in "
    + "`expectedLevels`). The attacker defaults to fixed Lv20 with class power 3; "
    + "these defaults are not inferred from this ROM. Pass `--actor-level`, "
    + "`--actor-class-power` or `--actor-promoted` to measure a different one. "
    + "By default every chapter is budgeted for all three difficulties; "
    + "`--difficulty` keeps one. "
    + "The formula constants "
    + "and their sources are in src/analysis/expcurve.ts; the "
    + "`meta.parameters.assumptions` block lists what is modelled rather than read - "
    + "including that every counted enemy is assumed killed, and that a "
    + "promoted attacker's class-bonus-B term is not modelled.",
  run: async ({ extract, flags }) => {
    const result = await expCurveOf(extract, {
      ...(flags.difficulty === undefined ? {} : { difficulty: difficultyFlag(flags.difficulty) }),
      ...(flags.actorLevel === undefined
        ? {}
        : { actorLevel: intFlag(flags.actorLevel, "actor-level") }),
      ...(flags.actorClassPower === undefined
        ? {}
        : { actorClassPower: intFlag(flags.actorClassPower, "actor-class-power") }),
      ...(flags.actorPromoted === undefined ? {} : { actorPromoted: flags.actorPromoted }),
    });
    return {
      data: {
        budgets: result.budgets.map((b) => ({
          ...b,
          expectedLevels: round2(b.expectedLevels),
        })),
      },
      // The modelling parameters belong in the envelope's `meta`: they are what
      // makes a quoted `totalExp` traceable to the run that produced it. The
      // formula's own sources and assumptions ride along as `parameters`.
      parameters: {
        actor: result.meta.actor,
        difficulties: result.meta.difficulties,
        sources: result.meta.sources,
        assumptions: result.meta.assumptions,
      },
    };
  },
});
