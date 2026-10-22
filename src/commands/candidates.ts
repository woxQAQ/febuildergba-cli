import { candidatesOf } from "../analysis/service.ts";
import { defineDbCommand } from "./types.ts";
import { chapterWindow } from "./chapterWindow.ts";

export const candidates = defineDbCommand({
  name: "candidates",
  input: "db",
  summary: "Audit candidate IDs, join overrides and branch-specific training facts",
  description:
    "The union of roster units and recognized joiners, joined by id with "
    + "availability, personal growths, unit-table baselines, earliest-map join "
    + "evidence and direct-branch projections/capabilities. `audit` reports exact "
    + "ID differences and evidence gaps. `baselineIssues` flags missing classes, "
    + "class/level overrides and entry autolevel without guessing which entry "
    + "is the actual one; affected plans "
    + "remain unit-table calculations, not verified entry projections. "
    + "`playOrder` includes chapter titles/numbers, normal/hard deployment slots, "
    + "branches and closed loops. `lastPlayable` is a model endpoint, not a verified "
    + "final chapter. `--from-position` / `--before-position` restrict availability "
    + "counts and gaps, never the audit, unit IDs, joins, plans or full play order. "
    + "This command does not rank units, allocate items or prove recruit control, "
    + "equipment, training feasibility or a single executable story route.",
  run: async ({ extract, flags }) => {
    const window = chapterWindow(flags, await extract.playOrder());
    return {
      data: await candidatesOf(extract, window),
      ...(window === undefined ? {} : { parameters: { window } }),
    };
  },
});
