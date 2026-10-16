/**
 * `expcurve` command: how much combat exp each chapter's enemy set hands out to
 * a unit of a stated level. The formula, its sources and the reason the level
 * is an input rather than an assumption live in `analysis/expcurve.ts`; this is
 * the shell.
 */

import { expCurveOf } from "../analysis/service.ts";
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

export const expcurve = defineDbCommand({
  name: "expcurve",
  input: "db",
  summary: "Show the exp each chapter's enemies give a stated attacker",
  description:
    "One row per playable chapter per difficulty: the counted enemies (initial " +
    "placements vs event loads/reinforcements), their modal class power, and " +
    "the total exp an attacker of the stated level and class power earns by " +
    "killing all of them (`totalExp`, and as level-ups in " +
    "`expectedLevels`). The attacker defaults to Lv20 with class power 3 (the " +
    "modal value across classes); pass `--actor-level`, `--actor-class-power` " +
    "or `--actor-promoted` to measure a different one. The formula constants " +
    "and their sources are in src/analysis/expcurve.ts; the " +
    "`meta.assumptions` block lists what is modelled rather than read - " +
    "including that every counted enemy is assumed killed, and that a " +
    "promoted attacker's class-bonus-B term is not modelled.",
  run: async ({ extract, flags }) => {
    const result = await expCurveOf(extract, {
      ...(flags.actorLevel === undefined
        ? {}
        : { actorLevel: intFlag(flags.actorLevel, "actor-level") }),
      ...(flags.actorClassPower === undefined
        ? {}
        : { actorClassPower: intFlag(flags.actorClassPower, "actor-class-power") }),
      ...(flags.actorPromoted === undefined ? {} : { actorPromoted: flags.actorPromoted }),
    });
    return {
      meta: result.meta,
      budgets: result.budgets.map((b) => ({
        ...b,
        expectedLevels: round2(b.expectedLevels),
      })),
    };
  },
});
