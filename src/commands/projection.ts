/**
 * `projection` command: each roster unit's read facts and its stat ceiling.
 * The arithmetic and what it deliberately excludes live in
 * `analysis/projection.ts`; this is the shell.
 */

import { projectionOf } from "../analysis/service.ts";
import { defineDbCommand } from "./types.ts";

export const projection = defineDbCommand({
  name: "projection",
  input: "db",
  summary: "Show each roster unit's starting stats and fully-trained ceiling",
  description:
    "For every roster unit (support-data bearing, the same predicate the " +
    "`roster` command uses): the class line, the unit table's join level, the " +
    "starting stats (`class base + unit delta`, exact), and the fully-trained " +
    "ceiling (`maxed`) - every growth succeeded to Lv20, promotion bonuses " +
    "applied, stats truncated by each class's cap along the way. Two facts " +
    "bracket the unit: where it enters and where it tops out; a stat at any " +
    "chapter between them depends on how much it was trained, which no table " +
    "states.",
  run: ({ extract }) => projectionOf(extract),
});
