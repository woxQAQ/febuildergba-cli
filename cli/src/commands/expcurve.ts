/**
 * `expcurve` command: the per-chapter experience budget - how much combat exp
 * each chapter offers an army fighting at the enemies' own level, per
 * difficulty. The formula, its sources and the parity modelling live in
 * `analysis/expcurve.ts`; this is the shell: parse, compute, round the one
 * fractional field for display.
 */

import { parseRom } from "../load.ts";
import { computeExpCurve } from "../analysis/expcurve.ts";
import type { Command } from "./types.ts";

/** Display rounding: levels are fractional by construction (exp / 100). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const expcurve: Command = {
  name: "expcurve",
  summary: "Show how much experience each chapter offers, per difficulty",
  description:
    "One row per playable chapter per difficulty: the counted enemies " +
    "(initial placements vs event loads/reinforcements), their modal class " +
    "power, and the total exp a unit fighting every enemy at that enemy's " +
    "own level would earn (`totalExpAtParity`, and as level-ups in " +
    "`expectedLevelsAtParity`). Level cancels at parity, so the budget is " +
    "driven by enemy count, class powers and boss/thief flags. The formula " +
    "constants and their sources are in src/analysis/expcurve.ts; the " +
    "`meta.assumptions` block lists what is modelled rather than read.",
  run: ({ rom }) => {
    const result = computeExpCurve(parseRom(rom));
    return {
      meta: result.meta,
      budgets: result.budgets.map((b) => ({
        ...b,
        expectedLevelsAtParity: round2(b.expectedLevelsAtParity),
      })),
    };
  },
};