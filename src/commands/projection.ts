/**
 * `projection` command: expected stats per chapter for every roster unit -
 * the growth half of "who is worth training". The expectation arithmetic and
 * its modelling choices (per-chapter levels, promotion timing, stepwise caps)
 * live in `analysis/projection.ts`; this is the shell.
 */

import { projectionOf } from "../analysis/service.ts";
import { defineDbCommand } from "./types.ts";

export const projection = defineDbCommand({
  name: "projection",
  input: "db",
  summary: "Project each roster unit's expected stats across the play order",
  description:
    "For every roster unit (support-data bearing, the same predicate the " +
    "`roster` command uses): the class line, the expected stats at each " +
    "chapter from its join on - per-chapter levels from the exp curve's " +
    "parity budget (see the `expcurve` command), promotion at base level " +
    "20 - the join-time exp-efficiency summary, and the fully-trained " +
    "ceiling (`maxed`). These are expectations for planning, not the game's " +
    "own simulation; see src/analysis/projection.ts for the difference from " +
    "derived_unit_stats.",
  run: ({ extract }) => projectionOf(extract),
});
